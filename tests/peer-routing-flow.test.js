'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parentTarget, babyTargetForParent, detachParentSocket, connectedParentIds } = require('../lib/peer-routing');

test('production routing keeps two concurrent Parents isolated through late join and single exit', () => {
  const session = {
    baby: { socketId: 'baby-socket' },
    parents: new Map([
      ['parent-1', { id: 'parent-1', socketId: 'parent-socket-1' }]
    ])
  };

  // Parent 1 is already LIVE.
  assert.equal(parentTarget(session, 'parent-1'), 'parent-socket-1');
  assert.equal(babyTargetForParent(session, 'parent-1', 'parent-socket-1'), 'baby-socket');

  // Parent 2 joins later and receives a different signaling destination.
  session.parents.set('parent-2', { id: 'parent-2', socketId: 'parent-socket-2' });
  assert.deepEqual(connectedParentIds(session), ['parent-1', 'parent-2']);
  assert.equal(parentTarget(session, 'parent-2'), 'parent-socket-2');
  assert.notEqual(parentTarget(session, 'parent-1'), parentTarget(session, 'parent-2'));
  assert.equal(babyTargetForParent(session, 'parent-2', 'parent-socket-2'), 'baby-socket');

  // Cross-parent spoofing cannot route an answer or ICE candidate.
  assert.equal(babyTargetForParent(session, 'parent-1', 'parent-socket-2'), null);
  assert.equal(babyTargetForParent(session, 'parent-2', 'parent-socket-1'), null);

  // Parent 2 exits: only its route is detached; Parent 1 remains LIVE.
  assert.equal(detachParentSocket(session, 'parent-2', 'parent-socket-2'), true);
  assert.equal(parentTarget(session, 'parent-2'), null);
  assert.equal(parentTarget(session, 'parent-1'), 'parent-socket-1');
  assert.deepEqual(connectedParentIds(session), ['parent-1']);
});
