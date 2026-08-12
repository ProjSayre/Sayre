'use client';

import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import type { RealtimeStatus } from '../types';
import { browserRealtimeUrl, parseGatewayMessage } from '../realtime';
import { getStoredSessionToken } from '../../lib/coreFetch';
import { useWorkspaceQueries } from './queries';
import { useWorkspaceSession } from './session';
import { useWorkspaceStore } from './store';

export interface WorkspaceRealtimeContextValue {
  status: RealtimeStatus;
  connectedRepositoryId: string | null;
}

const WorkspaceRealtimeContext = createContext<WorkspaceRealtimeContextValue | null>(null);

export function WorkspaceRealtimeProvider({ children }: { children: ReactNode }) {
  const { state, dispatch, source, gatewayWsUrl, allowLocalGatewayFallback } = useWorkspaceStore();
  const repositoryId = useWorkspaceSession().repository?.id ?? null;
  const { reloadGraph, reloadOverlay } = useWorkspaceQueries();

  useEffect(() => {
    if (source.id !== 'live' || repositoryId === null) {
      if (source.id === 'live') dispatch({ type: 'patch', patch: { realtime: 'not-connected' } });
      return undefined;
    }
    const url = browserRealtimeUrl(window.location, gatewayWsUrl ?? undefined, allowLocalGatewayFallback);
    if (url === null) {
      dispatch({ type: 'patch', patch: { realtime: 'not-connected' } });
      return undefined;
    }
    let active = true;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempt = 0;
    const settleToConnected = (): void => {
      if (settleTimer !== null) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => { if (active) dispatch({ type: 'patch', patch: { realtime: 'connected' } }); }, 1_400);
    };
    const scheduleReconnect = (): void => {
      if (!active || reconnectTimer !== null) return;
      dispatch({ type: 'patch', patch: { realtime: 'reconnecting' } });
      const delay = Math.min(20_000, 750 * 2 ** reconnectAttempt);
      reconnectAttempt += 1;
      reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
    };
    const connect = (): void => {
      if (!active) return;
      try { socket = new WebSocket(url); } catch { scheduleReconnect(); return; }
      socket.addEventListener('open', () => {
        const sessionToken = getStoredSessionToken();
        if (sessionToken !== null) socket?.send(JSON.stringify({ type: 'auth', token: sessionToken }));
        dispatch({ type: 'patch', patch: { realtime: 'reconnecting' } });
      });
      socket.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return;
        const message = parseGatewayMessage(event.data);
        if (message === null) return;
        if (message.type === 'ready') { socket?.send(JSON.stringify({ type: 'subscribe', repoId: repositoryId })); return; }
        if (message.type === 'subscribed' && 'repoId' in message && message.repoId === repositoryId) {
          reconnectAttempt = 0;
          dispatch({ type: 'patch', patch: { realtime: 'connected' } });
          return;
        }
        if ((message.type === 'graph.delta' || message.type === 'graph.resync') && message.repoId === repositoryId) {
          dispatch({ type: 'patch', patch: { realtime: message.type === 'graph.resync' ? 'resync-required' : 'updated' } });
          reloadGraph();
          reloadOverlay();
          settleToConnected();
          return;
        }
        if (message.type === 'error' && message.code === 'unauthenticated') {
          dispatch({ type: 'patch', patch: { session: 'session-expired' } });
          socket?.close();
        }
      });
      socket.addEventListener('close', (event) => {
        if (event.code === 4401) { dispatch({ type: 'patch', patch: { session: 'session-expired' } }); return; }
        scheduleReconnect();
      });
      socket.addEventListener('error', () => socket?.close());
    };
    connect();
    return () => {
      active = false;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      if (settleTimer !== null) clearTimeout(settleTimer);
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'unsubscribe', repoId: repositoryId }));
      socket?.close();
    };
  }, [allowLocalGatewayFallback, dispatch, gatewayWsUrl, reloadGraph, reloadOverlay, repositoryId, source.id]);

  const value = useMemo<WorkspaceRealtimeContextValue>(() => ({
    status: state.realtime,
    connectedRepositoryId: state.realtime === 'not-connected' ? null : repositoryId,
  }), [repositoryId, state.realtime]);
  return <WorkspaceRealtimeContext.Provider value={value}>{children}</WorkspaceRealtimeContext.Provider>;
}

export function useWorkspaceRealtime(): WorkspaceRealtimeContextValue {
  const value = useContext(WorkspaceRealtimeContext);
  if (value === null) throw new Error('useWorkspaceRealtime must be used inside WorkspaceRealtimeProvider.');
  return value;
}
