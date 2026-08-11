'use client';

/**
 * Workspace-scoped chat provider: owns lazy conversation creation, the
 * transcript, a dedicated chat WebSocket, degraded REST polling, and REST
 * reconciliation. Mounted once (see state/WorkspaceProvider.tsx) so every
 * view shares one conversation per workspace session.
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { getStoredSessionToken } from '../../lib/coreFetch';
import { browserRealtimeUrl, parseGatewayMessage } from '../realtime';
import { useWorkspaceQueries } from '../state/queries';
import { useWorkspaceSelection } from '../state/selection';
import { useWorkspaceSession } from '../state/session';
import { useWorkspaceStore } from '../state/store';
import {
  providerConfigurationStatus,
  type ProviderConfigurationStatus,
} from '../providerSettingsContract';
import type { ViewId } from '../types';
import {
  CHAT_DEGRADED_POLL_INTERVAL_MS,
  CHAT_DEGRADED_POLL_MAX_ATTEMPTS,
  parseChatGatewayMessage,
  type ChatCitation,
  type ChatScope,
} from './chatContract';
import {
  chatClient,
  ChatRequestError,
  newIdempotencyKey,
} from './chatClient';
import {
  appendTurnPair,
  applyChatEvent,
  emptyChatTranscript,
  hasActiveTurn,
  reconcileTranscript,
  type ChatTranscriptState,
  type ChatTranscriptTurn,
} from './chatTranscript';
import { citationTarget } from './citationTarget';

export type ChatLiveStatus = 'connecting' | 'connected' | 'degraded';

export interface WorkspaceChatContextValue {
  expanded: boolean;
  turns: readonly ChatTranscriptTurn[];
  /** Byte-for-byte what postTurn will send (AC-8). */
  scope: ChatScope;
  /** Display label for scope.anchorNodeId, or null when no node is selected. */
  anchorLabel: string | null;
  /** True while any of this conversation's assistant turns is 'pending' or 'running'. */
  busy: boolean;
  live: ChatLiveStatus;
  /** 'unknown' whenever provider settings could not be read — never blocks the input (AC-10). */
  providerStatus: ProviderConfigurationStatus | 'unknown';
  /** Inline composer error text (EC-19), or null. */
  composerError: string | null;
  /** True when the workspace data source is not 'live' — composer disabled with a stated reason. */
  inert: boolean;
  setExpanded(expanded: boolean): void;
  /** Clears only scope.anchorNodeId; the view is untouched (AC-7). */
  dismissAnchor(): void;
  ask(question: string): void;
  /** Re-posts the stored question + stored scope of `turnId` under a NEW idempotency key (AC-11). */
  retry(turnId: string): void;
  /** Manual reconcile — the degraded path's 'Check again' (EC-9). */
  refresh(): void;
  activateCitation(citation: ChatCitation): void;
}

const WorkspaceChatContext = createContext<WorkspaceChatContextValue | null>(null);

export function WorkspaceChatProvider({ children }: { children: ReactNode }) {
  const { state, dispatch, source, gatewayWsUrl, allowLocalGatewayFallback } = useWorkspaceStore();
  const session = useWorkspaceSession();
  const selection = useWorkspaceSelection();
  const { graph } = useWorkspaceQueries();

  // `state.view` is the store's own `ViewId`; the workspace-packs runtime's
  // broader `WorkspaceViewId = string` (what `useWorkspaceNavigation().viewId`
  // returns) is narrowed the same way drawer/NodeDrawer.tsx already does.
  const navigationViewId: ViewId = state.view;

  const [expanded, setExpandedState] = useState(true);
  const [dismissedNodeId, setDismissedNodeId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<ChatTranscriptState>(emptyChatTranscript);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [live, setLive] = useState<ChatLiveStatus>('connecting');
  const [providerStatus, setProviderStatus] = useState<ProviderConfigurationStatus | 'unknown'>('unknown');
  const [composerError, setComposerError] = useState<string | null>(null);

  const conversationIdRef = useRef<string | null>(null);
  const creatingRef = useRef<Promise<string> | null>(null);
  const transcriptRef = useRef(transcript);
  const socketRef = useRef<WebSocket | null>(null);
  const scopeKeyRef = useRef<string | null>(null);
  /**
   * Latched once the session is known to be gone (EC-24). Checked at every
   * point that would otherwise issue another chat REST call or resume
   * polling, so a 401 / gateway 'error' / close-4401 stops the chain rather
   * than retrying in a loop, and the provider's own reactive `socket.close()`
   * below never gets mistaken for a network drop that should start the
   * degraded poller.
   */
  const sessionExpiredRef = useRef(false);

  useEffect(() => {
    transcriptRef.current = transcript;
  }, [transcript]);

  const anchorNodeId =
    selection.selectedNodeId !== null && selection.selectedNodeId !== dismissedNodeId
      ? selection.selectedNodeId
      : null;
  const scope: ChatScope = useMemo(
    () => ({ view: navigationViewId, anchorNodeId }),
    [navigationViewId, anchorNodeId],
  );
  const anchorLabel = useMemo(() => {
    if (anchorNodeId === null) return null;
    return graph.nodes.find((node) => node.id === anchorNodeId)?.name ?? anchorNodeId;
  }, [anchorNodeId, graph.nodes]);
  const knownFeatureIds = useMemo(
    () => new Set(graph.features.map((feature) => feature.id)),
    [graph.features],
  );
  const busy = hasActiveTurn(transcript);
  const inert = source.id !== 'live';
  const providerBlocked = providerStatus === 'incomplete' || providerStatus === 'not-configured';

  // ---------------------------------------------------------- provider status

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    void source
      .providerSettings(controller.signal)
      .then((response) => {
        if (!active) return;
        setProviderStatus(providerConfigurationStatus(response.settings.generation));
      })
      .catch(() => {
        if (active) setProviderStatus('unknown');
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [source]);

  // -------------------------------------------------------------- reconcile

  /**
   * Resolves `true` when, after reconciling, the conversation still has a
   * non-terminal assistant turn — the degraded poller's own signal for
   * whether to keep going, computed from the state update itself rather than
   * a ref that may not have caught up yet. Never issues the request at all
   * once the session is known to be expired (EC-24: "stops polling ... rather
   * than retrying in a loop").
   */
  const reconcileNow = (id: string): Promise<boolean> => {
    if (sessionExpiredRef.current) return Promise.resolve(false);
    return chatClient
      .getConversation(id)
      .then((detail) => {
        let stillActive = false;
        setTranscript((previous) => {
          const next = reconcileTranscript(previous, detail);
          stillActive = hasActiveTurn(next);
          return next;
        });
        return stillActive;
      })
      .catch((error: unknown) => {
        if (error instanceof ChatRequestError && error.unauthenticated) handleSessionExpired();
        return false;
      });
  };

  function handleSessionExpired(): void {
    if (sessionExpiredRef.current) return;
    sessionExpiredRef.current = true;
    dispatch({ type: 'patch', patch: { session: 'session-expired' } });
    if (socketRef.current !== null) {
      socketRef.current.close();
      socketRef.current = null;
    }
  }

  // ------------------------------------------------------------------ socket

  useEffect(() => {
    if (conversationId === null) {
      setLive('connecting');
      return undefined;
    }
    const url = browserRealtimeUrl(window.location, gatewayWsUrl ?? undefined, allowLocalGatewayFallback);
    if (url === null) {
      setLive('degraded');
      return undefined;
    }
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      setLive('degraded');
      return undefined;
    }
    socketRef.current = socket;

    const handleOpen = (): void => {
      const token = getStoredSessionToken();
      if (token !== null) socket.send(JSON.stringify({ type: 'auth', token }));
      setLive('connected');
    };
    const handleMessage = (event: MessageEvent): void => {
      if (typeof event.data !== 'string') return;
      const generic = parseGatewayMessage(event.data);
      if (generic !== null) {
        if (generic.type === 'ready') {
          socket.send(JSON.stringify({ type: 'chat.subscribe', conversationId }));
          void reconcileNow(conversationId);
          return;
        }
        if (generic.type === 'error' && generic.code === 'unauthenticated') {
          handleSessionExpired();
          return;
        }
        return;
      }
      const chatMessage = parseChatGatewayMessage(event.data);
      if (chatMessage === null) return;
      setTranscript((previous) => applyChatEvent(previous, chatMessage));
    };
    const handleClose = (event: { code?: number }): void => {
      // A close that arrives after the session is already known to be
      // expired is either the socket.close() handleSessionExpired just
      // issued itself, or a straggler from one already in flight — either
      // way it must not flip live to 'degraded' and start the poller
      // (EC-24: session expiry must not *start* degraded polling).
      if (sessionExpiredRef.current) return;
      if (event.code === 4401) {
        handleSessionExpired();
        return;
      }
      setLive('degraded');
    };

    socket.addEventListener('open', handleOpen);
    socket.addEventListener('message', handleMessage as EventListener);
    socket.addEventListener('close', handleClose as EventListener);

    return () => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'chat.unsubscribe', conversationId }));
      }
      socket.close();
      if (socketRef.current === socket) socketRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, gatewayWsUrl, allowLocalGatewayFallback]);

  // ----------------------------------------------------------- degraded poll

  // `busy` (declared above from the current `transcript`) is deliberately a
  // dependency here, not just `conversationId`/`live`: it is what makes a
  // *newly posted* turn re-arm this effect (C1). Without it, the effect only
  // ever ran once per (conversationId, live) pairing, so an idle tick that
  // found nothing active could never be followed by a fresh chain once a
  // second question introduced a new non-terminal turn. Gating the effect's
  // very first timer on `busy` also closes the start-up race: the timer for
  // a turn cannot be armed until that turn has actually been appended to the
  // transcript (`busy` only flips true after `appendTurnPair`), so a
  // `postTurn` slower than `CHAT_DEGRADED_POLL_INTERVAL_MS` can no longer let
  // an early idle tick kill the chain before the turn exists. Because the
  // effect re-runs on every busy transition, `attempts` (a fresh local for
  // each run) is naturally scoped to the turn/stall it is bounding rather
  // than to the (conversationId, live) session lifetime.
  useEffect(() => {
    if (conversationId === null || live !== 'degraded' || !busy) return undefined;
    let active = true;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = (): void => {
      if (!active || sessionExpiredRef.current) return;
      attempts += 1;
      void reconcileNow(conversationId).then((stillActive) => {
        if (!active || sessionExpiredRef.current) return;
        // Reconcile itself decided the turn is now terminal (or the request
        // failed and handleSessionExpired already latched the session) — the
        // next non-terminal turn, if any, re-arms this effect on its own via
        // the `busy` dependency above; this chain does not keep going.
        if (!stillActive) return;
        if (attempts >= CHAT_DEGRADED_POLL_MAX_ATTEMPTS) return;
        timer = setTimeout(tick, CHAT_DEGRADED_POLL_INTERVAL_MS);
      });
    };
    timer = setTimeout(tick, CHAT_DEGRADED_POLL_INTERVAL_MS);

    return () => {
      active = false;
      if (timer !== null) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, live, busy]);

  // ------------------------------------------------------------- scope reset

  useEffect(() => {
    if (session.scope === null) return;
    const key = `${session.scope.repositoryId}:${session.scope.refName}`;
    const previous = scopeKeyRef.current;
    scopeKeyRef.current = key;
    if (previous === null || previous === key) return;
    conversationIdRef.current = null;
    creatingRef.current = null;
    setConversationId(null);
    setTranscript(emptyChatTranscript);
    setComposerError(null);
    setDismissedNodeId(null);
  }, [session.scope]);

  // ------------------------------------------------------------- actions

  function ensureConversation(): Promise<string> {
    if (conversationIdRef.current !== null) return Promise.resolve(conversationIdRef.current);
    if (creatingRef.current !== null) return creatingRef.current;
    const promise = chatClient
      .createConversation()
      .then((conversation) => {
        conversationIdRef.current = conversation.id;
        creatingRef.current = null;
        setConversationId(conversation.id);
        return conversation.id;
      })
      .catch((error: unknown) => {
        creatingRef.current = null;
        throw error;
      });
    creatingRef.current = promise;
    return promise;
  }

  function submit(question: string, scopeOverride?: ChatScope): void {
    if (question.trim().length === 0) return;
    if (hasActiveTurn(transcriptRef.current)) return;
    if (inert) return;
    if (providerBlocked) return;
    const usedScope = scopeOverride ?? scope;
    const idempotencyKey = newIdempotencyKey();
    void (async () => {
      try {
        const id = await ensureConversation();
        const result = await chatClient.postTurn(id, { question, scope: usedScope, idempotencyKey });
        setTranscript((previous) => appendTurnPair(previous, result.userTurn, result.assistantTurn, usedScope));
        setComposerError(null);
      } catch (error) {
        if (error instanceof ChatRequestError && error.unauthenticated) {
          handleSessionExpired();
          return;
        }
        const detail = error instanceof Error ? error.message : 'the request failed.';
        setComposerError(`Sayre could not send that question. ${detail}`);
      }
    })();
  }

  function ask(question: string): void {
    submit(question);
  }

  function retry(turnId: string): void {
    const current = transcriptRef.current;
    const index = current.turns.findIndex((turn) => turn.id === turnId);
    if (index <= 0) return;
    const assistantTurn = current.turns[index];
    const userTurn = current.turns[index - 1];
    if (assistantTurn === undefined || userTurn === undefined || userTurn.role !== 'user') return;
    submit(userTurn.content, assistantTurn.scope ?? scope);
  }

  function refresh(): void {
    if (conversationId === null) return;
    void reconcileNow(conversationId);
  }

  function dismissAnchor(): void {
    setDismissedNodeId(selection.selectedNodeId);
  }

  function activateCitation(citation: ChatCitation): void {
    const target = citationTarget(citation, { view: navigationViewId, knownFeatureIds });
    if (target.kind === 'select-node') {
      if (navigationViewId === 'technical') selection.selectNode(target.nodeId);
      else selection.openNodeInTechnicalView(target.nodeId);
    } else if (target.kind === 'select-feature') {
      selection.selectFeature(target.featureId);
    }
  }

  const value: WorkspaceChatContextValue = {
    expanded,
    turns: transcript.turns,
    scope,
    anchorLabel,
    busy,
    live,
    providerStatus,
    composerError,
    inert,
    setExpanded: setExpandedState,
    dismissAnchor,
    ask,
    retry,
    refresh,
    activateCitation,
  };

  return <WorkspaceChatContext.Provider value={value}>{children}</WorkspaceChatContext.Provider>;
}

export function useWorkspaceChat(): WorkspaceChatContextValue {
  const value = useContext(WorkspaceChatContext);
  if (value === null) throw new Error('useWorkspaceChat must be used inside WorkspaceChatProvider.');
  return value;
}
