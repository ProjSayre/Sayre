"""Async-messaging package for the Python worker fleet (SQS wrapper + envelope).

SQS is the permanent broker for the Python worker fleet; BullMQ is the permanent broker
for Node integration workers — see `.claude/rules/async-messaging.md`. Do not add a
BullMQ/Redis client here.
"""
