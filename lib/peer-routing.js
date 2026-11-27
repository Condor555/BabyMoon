'use strict';

/**
 * Pure routing helpers shared by the production Socket.IO handlers and tests.
 * A signaling message is never broadcast: it resolves to exactly one socket.
 */
function parentTarget(session, parentId) {
  if (!session || typeof parentId !== 'string') return null;
  return session.parents.get(parentId)?.socketId || null;
}

function babyTargetForParent(session, parentId, sourceSocketId) {
  if (!session || typeof parentId !== 'string' || typeof sourceSocketId !== 'string') return null;
  const parent = session.parents.get(parentId);
  if (!parent || parent.socketId !== sourceSocketId) return null;
  return session.baby.socketId || null;
}

function detachParentSocket(session, parentId, sourceSocketId) {
  if (!session) return false;
  const parent = session.parents.get(parentId);
  if (!parent || parent.socketId !== sourceSocketId) return false;
  parent.socketId = null;
  return true;
}

function connectedParentIds(session) {
  if (!session) return [];
  return [...session.parents.values()].filter((parent) => Boolean(parent.socketId)).map((parent) => parent.id);
}

module.exports = { parentTarget, babyTargetForParent, detachParentSocket, connectedParentIds };
