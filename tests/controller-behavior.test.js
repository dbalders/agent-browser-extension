import { expect, it, vi } from 'vitest';
import { BrowserController } from '../extension/controller.js';

it('preserves a renamed group and its color/collapse preference when more background tabs open', async () => {
  let next = 1;
  const tabs = new Map(); const group = { id: 7 };
  const chrome = {
    tabs: {
      create: async properties => { const tab = { id: next++, windowId: 1, groupId: -1, ...properties }; tabs.set(tab.id, tab); return tab; },
      get: async id => tabs.get(id),
      query: async () => [...tabs.values()],
      group: async ({ tabIds }) => { for (const id of tabIds) tabs.get(id).groupId = group.id; return group.id; },
    },
    tabGroups: { get: async () => group, update: vi.fn(async (_id, update) => Object.assign(group, update)) },
  };
  const controller = new BrowserController(chrome, {});
  const run = (operation, args) => controller.execute({ type: 'command', id: 'command', sessionId: 'task', operation, args });
  await run('session.start', { name: 'Research' });
  await run('tabs.open', { url: 'https://example.test/first' });
  await run('groups.update', { title: 'Supplier shortlist', color: 'purple', collapsed: false });
  await run('tabs.open', { url: 'https://example.test/second', background: true });
  expect(group).toEqual({ id: 7, title: 'Supplier shortlist', color: 'purple', collapsed: false });
  expect(tabs.get(2).active).toBe(false);
  await run('groups.update', { collapsed: true });
  await run('tabs.open', { url: 'https://example.test/third', background: false });
  expect(group).toEqual({ id: 7, title: 'Supplier shortlist', color: 'purple', collapsed: false });
});

it('splits owned tabs before regrouping when a released group member belongs to another task', async () => {
  const tabs = new Map(); const groups = new Map(); let nextTab = 1; let nextGroup = 10;
  const chrome = {
    tabs: {
      create: async properties => { const tab = { id: nextTab++, windowId: 1, groupId: -1, ...properties }; tabs.set(tab.id, tab); return tab; },
      get: async id => tabs.get(id), query: async () => [...tabs.values()],
      group: async ({ tabIds, groupId }) => { const id = groupId ?? nextGroup++; if (!groups.has(id)) groups.set(id, { id }); for (const tab of tabIds) tabs.get(tab).groupId = id; return id; },
    },
    tabGroups: { get: async id => groups.get(id), update: async (id, update) => Object.assign(groups.get(id), update) },
  };
  const controller = new BrowserController(chrome, { detach: async () => {} });
  const run = (sessionId, operation, args = {}) => controller.execute({ type: 'command', id: 'command', sessionId, operation, args });
  await run('one', 'session.start', { name: 'First task' }); await run('two', 'session.start', { name: 'Second task' });
  const first = await run('one', 'tabs.open', { url: 'https://example.test/first' });
  const second = await run('one', 'tabs.open', { url: 'https://example.test/second' });
  await run('one', 'tabs.release', { tabId: first.tabId }); await run('two', 'tabs.claim', { tabId: first.tabId });
  await run('one', 'groups.update', { title: 'First task only', color: 'purple', collapsed: false });
  expect(groups.get(first.groupId)).toMatchObject({ title: 'First task', color: 'blue', collapsed: true });
  expect(tabs.get(first.tabId).groupId).toBe(first.groupId);
  expect(tabs.get(second.tabId).groupId).not.toBe(first.groupId);
  expect(groups.get(tabs.get(second.tabId).groupId)).toMatchObject({ title: 'First task only', color: 'purple', collapsed: false });
});
