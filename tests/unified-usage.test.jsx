import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { collectUnifiedUsage, combineUsage, readInstanceUsage, validateUsageSummary, projectUsageSnapshot } from '../src/connect/unified-usage.js';
import { saveInstance, forgetInstance } from '../src/connect/client.js';
import { cacheUsage, cachedUsage } from '../src/connect/usage-cache.js';
import { ConnectRoot, switchInstanceStorage } from '../src/connect/ConnectRoot.jsx';
import { UsagePage } from '../src/App.jsx';

const summary = (cost = 10, trackingDays = 10, overrides = {}) => ({
  rangeDays: 30, trackingDays, recordingStartedAt: '2026-08-01T10:00:00Z',
  stats: { todayCostUsd: cost, currentWeekCostUsd: cost, currentMonthCostUsd: cost, projectedMonthCostUsd: cost * 2, allTimeCostUsd: cost, allTimeTokens: cost * 100, dailyAverageCostUsd: cost / trackingDays },
  selected: { costUsd: cost, totalTokens: cost * 100, inputTokens: cost * 60, outputTokens: cost * 40, events: 2, unpricedEvents: 1 },
  daily: [{ date: '2026-08-01', costUsd: cost, totalTokens: cost * 100, events: 2 }],
  models: [{ provider: 'codex', model: 'gpt-5.6-sol', costUsd: cost, totalTokens: cost * 100 }],
  pricing: [], ...overrides
});
const instance = (id) => ({ id, name: `Host ${id}`, endpoint: `https://${id}.example`, token: `token-${id}` });
const json = (value, status = 200) => ({ ok: status < 400, status, json: async () => value });
const limits = (percent) => ({ providers: [{ provider: 'codex', label: 'Codex', status: 'available', limits: [{ id: 'codex', windows: [{ usedPercent: 100 - percent, remainingPercent: percent, windowDurationMins: 300 }] }] }] });
function mockRemote(values) {
  const fetch = vi.fn(async (url, options) => {
    const id = new URL(url).hostname.split('.')[0];
    const host = values[id];
    if (host instanceof Error) throw host;
    if (url.endsWith('/info')) return json({ hostId: id, instanceId: `process-${id}`, protocol: 1 });
    const body = JSON.parse(options.body);
    if (host === 'revoked') return json({ error: 'Pair this device again.' }, 401);
    return json({ result: body.operation === 'usage.summary' ? host.summary : host.limits });
  });
  vi.stubGlobal('fetch', fetch); return fetch;
}
const collect = (options) => { let entries; return collectUnifiedUsage({ instances: [], days: 30, signal: new AbortController().signal, onEntries: (next) => { entries = next; }, ...options }).then(() => entries); };
beforeEach(() => { localStorage.clear(); });
afterEach(() => { delete window.pixice; delete window.pixiceRemote; vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('unified usage accounting and transport', () => {
  it('sums costs, token mix and date/model buckets once per host, using a common span for averages', () => {
    const a = { id: 'a', summary: summary(10, 10) };
    const b = { id: 'b', summary: summary(20, 20, { daily: [{ date: '2026-08-01', costUsd: 15 }, { date: '2026-08-02', costUsd: 5 }] }) };
    const result = combineUsage([a, b, a, { id: 'offline', status: 'unavailable' }], 30);
    expect(result.stats).toMatchObject({ allTimeCostUsd: 30, allTimeTokens: 3000, dailyAverageCostUsd: 1.5, weeklyAverageCostUsd: 10.5 });
    expect(result.selected).toMatchObject({ costUsd: 30, totalTokens: 3000, inputTokens: 1800, outputTokens: 1200, events: 4, unpricedEvents: 2 });
    expect(result.daily.map((row) => row.costUsd)).toEqual([25, 5]);
    expect(result.models).toHaveLength(1);
    expect(result.models[0].costUsd).toBe(30);
    expect(result.limits).toBeUndefined();
    expect(combineUsage([{ id: 'offline' }], 7)).toBeNull();
  });
  it('keeps different providers separate and uses the newest reported rate without repricing history', () => {
    const rate = { provider: 'codex', model: 'same', rates: { input: 1 } };
    const result = combineUsage([
      { id: 'a', summary: summary(10, 10, { models: [{ provider: 'codex', model: 'same', costUsd: 10 }], pricingVerifiedAt: '2026-08-01', pricing: [rate] }) },
      { id: 'b', summary: summary(20, 20, { models: [{ provider: 'claude', model: 'same', costUsd: 20 }], pricingVerifiedAt: '2026-08-20', pricing: [{ ...rate, rates: { input: 2 } }] }) }
    ], 30);
    expect(result.models).toHaveLength(2);
    expect(result.pricing[0].rates.input).toBe(2);
    expect(result.stats.allTimeCostUsd).toBe(30);
  });
  it('rejects malformed summaries instead of reporting a successful zero', () => {
    expect(() => validateUsageSummary({})).toThrow('compatible');
    expect(() => validateUsageSummary(summary(10, 10, { stats: { allTimeCostUsd: NaN } }))).toThrow('compatible');
  });
  it('deduplicates a saved local connection and fetches remote usage without events or bootstrap', async () => {
    const fetch = mockRemote({ b: { summary: summary(20), limits: limits(50) } });
    const localApi = { connect: { status: vi.fn().mockResolvedValue({ hostId: 'a', name: 'My desktop' }) }, usage: { summary: vi.fn().mockResolvedValue(summary()), limits: vi.fn().mockResolvedValue(limits(60)) } };
    const entries = await collect({ localApi, instances: [instance('a'), instance('b'), instance('b')] });
    expect(entries).toHaveLength(2);
    expect(combineUsage(entries, 30).stats.allTimeCostUsd).toBe(30);
    expect(localApi.usage.summary).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[0][1].headers.Authorization).toBeUndefined();
    expect(fetch.mock.calls.slice(1).map(([, options]) => JSON.parse(options.body).operation).sort()).toEqual(['usage.limits', 'usage.summary']);
    expect(fetch.mock.calls[1][1].headers.Authorization).toBe('Bearer token-b');
  });
  it('does not transmit saved credentials to a changed host', async () => {
    const fetch = vi.fn(async () => json({ hostId: 'other', protocol: 1 })); vi.stubGlobal('fetch', fetch);
    await expect(readInstanceUsage(instance('a'), 7, new AbortController().signal)).rejects.toThrow('identity changed');
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });
  it('keeps offline and revoked instances visible, while successful hosts still contribute', async () => {
    mockRemote({ a: { summary: summary(20), limits: limits(50) }, b: new Error('Offline'), c: 'revoked' });
    const entries = await collect({ instances: ['a', 'b', 'c'].map(instance) });
    expect(entries.map((entry) => entry.status)).toEqual(['online', 'unavailable', 'unauthorized']);
    expect(combineUsage(entries, 30).stats.allTimeCostUsd).toBe(20);
  });
  it('withholds an unidentified local snapshot and does not invent a second host', async () => {
    mockRemote({ a: { summary: summary(20) } });
    const entries = await collect({ localApi: { connect: { status: () => Promise.reject(new Error('Not ready')) }, usage: { summary: vi.fn() } }, instances: [instance('a')] });
    expect(entries[0].status).toBe('unavailable');
    expect(combineUsage(entries, 30).stats.allTimeCostUsd).toBe(20);
  });
  it('aborts outstanding reads and suppresses later snapshots when the view is closed', async () => {
    const controller = new AbortController();
    const onEntries = vi.fn();
    vi.stubGlobal('fetch', vi.fn((_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason)))));
    const pending = collectUnifiedUsage({ instances: [instance('a')], days: 30, signal: controller.signal, onEntries });
    controller.abort();
    await pending;
    expect(onEntries).toHaveBeenCalledOnce();
    expect(onEntries.mock.calls[0][0][0].status).toBe('loading');
  });
});

function Page({ days = 30, onRangeChange = vi.fn() }) {
  return <UsagePage summary={summary()} limits={limits(60)} rangeDays={days} onRangeChange={onRangeChange} onRefresh={vi.fn()} />;
}
describe('unified usage view', () => {
  it('switches from instance usage to combined charts, reports partial coverage, and keeps limits per host', async () => {
    window.pixice = { connect: { status: async () => ({ hostId: 'local-id', name: 'My desktop' }) }, usage: { summary: async () => summary(10), limits: async () => limits(60) } };
    ['a', 'b'].forEach((id) => saveInstance(instance(id)));
    const fetch = mockRemote({ a: { summary: summary(20), limits: limits(25) }, b: new Error('Offline') });
    render(<Page />);
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Unified Usage' }));
    const table = await screen.findByRole('region', { name: 'Unified usage instances' });
    await waitFor(() => expect(within(table).getByText('2 of 3 included')).toBeInTheDocument());
    expect(within(table).getByText('Unavailable')).toBeInTheDocument();
    expect(within(table).getByText(/Partial totals/)).toBeInTheDocument();
    expect(screen.getByLabelText('$30.00', { selector: '.usage-hero-lifetime .number-ticker' })).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '60');
    fireEvent.change(screen.getByLabelText('Provider limits for'), { target: { value: 'a' } });
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25');
    fireEvent.click(screen.getByRole('button', { name: 'This instance' }));
    expect(screen.queryByRole('region', { name: 'Unified usage instances' })).not.toBeInTheDocument();
  });
  it('ignores old range responses and includes an offline instance after refresh', async () => {
    saveInstance(instance('a'));
    mockRemote({ a: new Error('Offline') });
    const { rerender } = render(<Page />);
    fireEvent.click(screen.getByRole('button', { name: 'Unified Usage' }));
    await screen.findByText('Unavailable');
    expect(screen.queryByRole('region', { name: 'Usage overview' })).not.toBeInTheDocument();
    let resolveOld;
    const old = new Promise((resolve) => { resolveOld = resolve; });
    const fetch = mockRemote({ a: { summary: summary(70), limits: limits(50) } });
    const real = fetch.getMockImplementation();
    fetch.mockImplementation((url, options) => options.body && JSON.parse(options.body).operation === 'usage.summary' && JSON.parse(options.body).payload.days === 30 ? old : real(url, options));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh unified usage' }));
    await waitFor(() => expect(fetch.mock.calls.some(([, options]) => options.body && JSON.parse(options.body).payload?.days === 30)).toBe(true));
    rerender(<Page days={7} />);
    await waitFor(() => expect(screen.getByLabelText('$70.00', { selector: '.usage-hero-lifetime .number-ticker' })).toBeInTheDocument());
    await act(async () => { resolveOld(json({ result: summary(999) })); });
    expect(screen.queryByLabelText('$999.00', { selector: '.usage-hero-lifetime .number-ticker' })).not.toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Tokens · 7d' })).toBeInTheDocument();
  });
});


describe('durable usage snapshots', () => {
  it('retains offline and revoked snapshots across reloads and replaces them when the host returns', async () => {
    const raw = summary(20, 20, { calendarTimeZone: 'UTC', calendarDate: '2026-09-05', recordingStartDate: '2026-08-01', historyDailyModels: [{ date: '2026-09-05', provider: 'codex', model: 'gpt-5.6-sol', costUsd: 20, totalTokens: 2000 }] });
    mockRemote({ a: { summary: raw, limits: limits(25) } });
    const first = await collect({ instances: [instance('a')] });
    const checkedAt = first[0].checkedAt;
    expect(cachedUsage('a', 30).summary.stats.allTimeCostUsd).toBe(20);
    switchInstanceStorage(null, 'another-host');
    mockRemote({ a: new Error('Offline') });
    const offline = await collect({ instances: [instance('a')], days: 7 });
    expect(offline[0]).toMatchObject({ cached: true, status: 'unavailable', checkedAt });
    expect(combineUsage(offline, 7).stats.allTimeCostUsd).toBe(20);
    mockRemote({ a: 'revoked' });
    const revoked = await collect({ instances: [instance('a')] });
    expect(revoked[0]).toMatchObject({ cached: true, status: 'unauthorized', checkedAt });
    expect(combineUsage(revoked, 30).stats.allTimeCostUsd).toBe(20);
    mockRemote({ a: { summary: summary(35), limits: limits(20) } });
    const reconnected = await collect({ instances: [instance('a')] });
    expect(reconnected[0].cached).toBe(false);
    expect(combineUsage(reconnected, 30).stats.allTimeCostUsd).toBe(35);
    // Reading a fresh module models restarting the renderer rather than retaining React state.
    vi.resetModules();
    const cacheAfterRestart = await import('../src/connect/usage-cache.js');
    expect(cacheAfterRestart.cachedUsage('a', 30).summary.stats.allTimeCostUsd).toBe(35);
    expect(localStorage.getItem('pixice.connect.usage-snapshots')).not.toContain('token-a');
    forgetInstance('a');
    expect(cachedUsage('a', 30)).toBeNull();
  });
  it('advances offline day/month boundaries without discarding lifetime history or adding stale month totals', () => {
    const snapshot = { checkedAt: Date.parse('2026-08-31T20:00:00Z'), summary: summary(30, 31, {
      calendarDate: '2026-08-31', calendarTimeZone: 'UTC', recordingStartDate: '2026-08-01',
      historyDailyModels: [
        { date: '2026-08-01', provider: 'codex', model: 'gpt-5.6-sol', costUsd: 10, totalTokens: 1000 },
        { date: '2026-08-31', provider: 'codex', model: 'gpt-5.6-sol', costUsd: 20, totalTokens: 2000 }
      ]
    }) };
    const week = projectUsageSnapshot(snapshot, 7, new Date('2026-09-01T12:00:00Z'));
    expect(week.stats).toMatchObject({ allTimeCostUsd: 30, currentMonthCostUsd: 0, todayCostUsd: 0, currentWeekCostUsd: 20 });
    expect(week.selected.costUsd).toBe(20);
    expect(week.models[0].costUsd).toBe(20);
    expect(week.daily.at(-1)).toMatchObject({ date: '2026-09-01', costUsd: 0 });
    const quarter = projectUsageSnapshot(snapshot, 90, new Date('2026-09-01T12:00:00Z'));
    expect(quarter.selected.costUsd).toBe(30);
    expect(quarter.models[0].costUsd).toBe(30);
    expect(quarter.heatmapDaily).toHaveLength(365);
  });
  it('uses the host time zone at a calendar boundary and preserves empty history', () => {
    const snapshot = { checkedAt: Date.now(), summary: summary(10, 1, { calendarTimeZone: 'America/Los_Angeles', recordingStartDate: '2026-08-31', historyDailyModels: [{ date: '2026-08-31', provider: 'codex', model: 'x', costUsd: 10 }] }) };
    expect(projectUsageSnapshot(snapshot, 7, new Date('2026-09-01T01:00:00Z')).stats.currentMonthCostUsd).toBe(10);
    const empty = { checkedAt: Date.now(), summary: summary(0, 1, { recordingStartedAt: null, historyDailyModels: [] }) };
    expect(projectUsageSnapshot(empty, 90).stats.allTimeCostUsd).toBe(0);
  });
  it('keeps the previous snapshot if a refresh is malformed, and reports storage failures honestly', async () => {
    cacheUsage('a', 30, { summary: summary(20), checkedAt: Date.now() });
    mockRemote({ a: { summary: summary(99, 10, { daily: [null] }) } });
    const broken = await collect({ instances: [instance('a')] });
    expect(broken[0].status).toBe('unavailable');
    expect(broken[0].summary.stats.allTimeCostUsd).toBe(20);
    mockRemote({ a: { summary: summary(40) } });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError'); });
    const full = await collect({ instances: [instance('a')] });
    expect(full[0].cacheError).toContain('this session only');
    mockRemote({ a: new Error('Offline') });
    const offline = await collect({ instances: [instance('a')] });
    expect(offline[0].summary.stats.allTimeCostUsd).toBe(40);
  });
  it('opens saved usage from the connection screen with every host offline', async () => {
    saveInstance(instance('a'));
    cacheUsage('a', 30, { summary: summary(20), checkedAt: Date.now() });
    mockRemote({ a: new Error('Offline') });
    render(<ConnectRoot><p>Workspace</p></ConnectRoot>);
    fireEvent.click(screen.getByRole('button', { name: 'View Unified Usage' }));
    await screen.findByText('Saved · offline');
    expect(screen.getByLabelText('$20.00', { selector: '.usage-hero-lifetime .number-ticker' })).toBeInTheDocument();
    expect(screen.getByText(/last saved usage/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to connections' }));
    expect(screen.getByRole('heading', { name: 'Pixice Connect' })).toBeInTheDocument();
  });
});
