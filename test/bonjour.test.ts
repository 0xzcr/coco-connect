// Real Bonjour on this machine's real network adapters. Off by default because it announces on
// your actual Wi-Fi and needs multicast to work locally:
//   COCO_TEST_BONJOUR=1 npm test

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CocoNode } from '../src/room.ts';
import { lanAddresses } from '../src/netinfo.ts';
import { cloneOf, makeOrigin, waitFor } from './helpers.ts';

const enabled = process.env.COCO_TEST_BONJOUR === '1' && lanAddresses().length > 0;

test('joining with only a code finds the host over Bonjour', { skip: !enabled && 'set COCO_TEST_BONJOUR=1' }, async () => {
  const origin = makeOrigin();
  // Random port for the host: the code's IP hint guesses the default port, so only Bonjour can find it.
  const host = new CocoNode({ projectDir: cloneOf(origin), name: 'host', lanPort: 0 });
  const guest = new CocoNode({ projectDir: cloneOf(origin), name: 'guest', lanPort: 0 });
  await host.init();
  await guest.init();

  try {
    const { code } = await host.pair();
    await guest.join(code);
    assert.equal(guest.inRoom, true);

    await waitFor(() => host.status().teammates[0]?.connection === 'direct', 8000, 'a direct link');
    assert.equal(host.discoveryHealth().every((adapter) => adapter.error === null), true);
  } finally {
    await guest.close();
    await host.close();
  }
});
