// Unit test for playlistAccess middleware — admin view+copy, no edit.
// Run: node tests/playlist-access-admin-test.js
//
// The middleware does `require('../db/client')` at module load, so we stub that
// module in the require cache BEFORE requiring the middleware. The stub lets each
// test control what prisma.playlist.findUnique returns.

const path = require('path');

// ---- Stub the prisma client module ----
const clientPath = require.resolve('../src/db/client');
let nextPlaylist = null; // set per-test
require.cache[clientPath] = {
  id: clientPath,
  filename: clientPath,
  loaded: true,
  exports: {
    playlist: {
      findUnique: async () => nextPlaylist,
    },
  },
};

const { playlistAccess, requireOwner, requireView } = require('../src/middleware/playlistAccess');

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  PASS: ${name}`); }
  else { failed++; console.log(`  FAIL: ${name}`); }
}

// Run the playlistAccess middleware and return the computed req.playlistAccess
// (or the error passed to next()).
async function run({ user, playlist }) {
  nextPlaylist = playlist;
  const req = { params: { id: 'pl1' }, user };
  let nextErr;
  await playlistAccess(req, {}, (err) => { nextErr = err; });
  return { access: req.playlistAccess, err: nextErr };
}

const OWNER = 'owner-id';
const ADMIN = { id: 'admin-id', role: 'ADMIN' };
const MEMBER = { id: 'member-id', role: 'MEMBER' };

// Base private playlist owned by someone else, no shares/copy grants.
function privatePlaylist() {
  return { id: 'pl1', userId: OWNER, isPublic: false, shares: [], copyPermissions: [] };
}

(async () => {
  // -------------------------------------------------------------------------
  console.log('Test 1: ADMIN can view + copy any private playlist they do not own');
  {
    const { access, err } = await run({ user: ADMIN, playlist: privatePlaylist() });
    check('no error', !err);
    check('canView true', access.canView === true);
    check('canCopy true', access.canCopy === true);
    check('canEdit false (admin is NOT owner)', access.canEdit === false);
    check('isOwner false', access.isOwner === false);
  }

  // -------------------------------------------------------------------------
  console.log('Test 2: ADMIN is blocked by requireOwner (cannot edit)');
  {
    const { access } = await run({ user: ADMIN, playlist: privatePlaylist() });
    const req = { playlistAccess: access };
    let ownerErr;
    requireOwner(req, {}, (err) => { ownerErr = err; });
    check('requireOwner rejects admin', !!ownerErr);

    let viewErr;
    requireView(req, {}, (err) => { viewErr = err; });
    check('requireView allows admin', !viewErr);
  }

  // -------------------------------------------------------------------------
  console.log('Test 3: regular MEMBER still cannot view/copy a private playlist they lack grants for');
  {
    const { access } = await run({ user: MEMBER, playlist: privatePlaylist() });
    check('member canView false', access.canView === false);
    check('member canCopy false', access.canCopy === false);
    check('member canEdit false', access.canEdit === false);
  }

  // -------------------------------------------------------------------------
  console.log('Test 4: OWNER (as a MEMBER) keeps full access including edit');
  {
    const owner = { id: OWNER, role: 'MEMBER' };
    const { access } = await run({ user: owner, playlist: privatePlaylist() });
    check('owner canView true', access.canView === true);
    check('owner canCopy true', access.canCopy === true);
    check('owner canEdit true', access.canEdit === true);
    check('owner isOwner true', access.isOwner === true);
  }

  // -------------------------------------------------------------------------
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
