import { diffLists } from '../domain/listDiff.ts';
import { enqueue, initialRunState, rollDay, startBatch } from '../domain/queue.ts';
import { entryKey, entryKeys } from '../domain/handle.ts';
import { DEFAULT_SETTINGS } from '../domain/types.ts';
import { fetchRemoteList, loadBundledSeed, persistList } from '../application/listService.ts';
import { buildPreviewSnapshot } from '../application/previewService.ts';
import {
  alarmNameDaily,
  alarmNameNext,
  alarmNameResume,
  alarmNameTick,
  ensureAlarms,
  pauseQueue,
  processNext,
  startQueue,
} from '../application/queueRunner.ts';
import { getSelf, openXSession, peekSelf } from '../application/session.ts';
import { describeError } from '../domain/errors.ts';
import { clearDiag, loadDiag } from '../infra/diagnostics.ts';
import { appendLog, loadStore, mergeSettingsPatch, savePartial } from '../infra/storage.ts';
import {
  assertSenderAllowed,
  filterAgainstWhitelist,
  previewEntriesFor,
  sanitizeEntries,
  sanitizeList,
  sanitizeQueueItems,
  sanitizeFabPos,
} from './messageGuard.ts';
import { POS_KEY, parseStoredPosition } from '../content/fabPosition.ts';
import type { Msg, MsgResponse, StatusSnapshot } from '../shared/messages.ts';
import { currentFabProgress, refreshProgressUi } from './progressUi.ts';
import { reinjectContentScripts, shouldReinject, type ReinjectApi } from './reinject.ts';

// Badge + bouton x.com : mis à jour sur changement d'état, jamais par minuteur.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.run || changes.queue || changes.settings)) void refreshProgressUi();
});
chrome.runtime.onStartup?.addListener(() => void refreshProgressUi());
void refreshProgressUi();

chrome.runtime.onInstalled.addListener((details) => {
  // Onglets x.com ouverts avant l'installation / la mise à jour : y remettre le bouton.
  if (shouldReinject(details?.reason)) {
    void reinjectContentScripts(chrome as unknown as ReinjectApi).catch(() => undefined);
  }
  void (async () => {
    const store = await loadStore();
    if (!store.list) {
      try {
        const { list } = await loadBundledSeed();
        await persistList(list, 'seed');
      } catch (e) {
        await appendLog({ at: Date.now(), level: 'error', message: `Seed: ${(e as Error).message}` });
      }
    }
    if (!store.run.dayKey) {
      await savePartial({ run: initialRunState(), settings: store.settings ?? DEFAULT_SETTINGS });
    }
    await ensureAlarms(store.settings.autoRefresh);
  })();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  void (async () => {
    if (alarm.name === alarmNameTick() || alarm.name === alarmNameResume() || alarm.name === alarmNameNext()) {
      await refreshProgressUi(); // badge des reprises différées (minutes restantes)
      const store = await loadStore();
      if (store.run.running || (store.run.resumeAt && store.run.resumeAt <= Date.now() && store.queue.length)) {
        if (!store.run.running && store.queue.length) {
          await savePartial({
            run: { ...rollDay(store.run), running: true, resumeAt: null, resumeReason: null },
          });
        }
        await processNext();
      }
    }
    if (alarm.name === alarmNameDaily()) {
      /* autoRefresh désactivé dans l'UI simplifiée */
    }
  })();
});

chrome.runtime.onMessage.addListener((message: Msg, sender, sendResponse) => {
  void (async () => {
    try {
      assertSenderAllowed(message, sender);
      const resp = await handle(message, sender);
      sendResponse(resp);
    } catch (e) {
      sendResponse({ ok: false, error: describeError(e) } satisfies MsgResponse);
    }
  })();
  return true;
});

async function statusSnapshot(): Promise<StatusSnapshot> {
  const store = await loadStore();
  const self = peekSelf();
  const sessionOk = !!self;
  return {
    settings: store.settings,
    list: store.list,
    listSource: store.listSource,
    listFetchedAt: store.listFetchedAt,
    whitelist: store.whitelist,
    queue: store.queue,
    run: rollDay(store.run),
    blockedByExt: store.blockedByExt,
    sessionOk,
    self,
  };
}

async function handle(msg: Msg, _sender: chrome.runtime.MessageSender): Promise<MsgResponse> {
  switch (msg.type) {
    case 'PING':
      return { ok: true, pong: true };
    case 'GET_PROGRESS':
      return { ok: true, progress: await currentFabProgress() };
    case 'GET_FAB_POS': {
      const data = (await chrome.storage.local.get(POS_KEY)) as Record<string, unknown>;
      const saved = parseStoredPosition(data[POS_KEY]);
      let fabPos = null;
      try {
        fabPos = saved ? sanitizeFabPos(saved) : null;
      } catch {
        fabPos = null; // valeur hors bornes en stockage → position par défaut
      }
      return { ok: true, fabPos };
    }
    case 'SET_FAB_POS': {
      const fabPos = sanitizeFabPos((msg as { pos?: unknown }).pos);
      await chrome.storage.local.set({ [POS_KEY]: fabPos });
      return { ok: true, fabPos };
    }
    case 'GET_STATUS':
      return { ok: true, status: await statusSnapshot() };
    case 'GET_SETTINGS': {
      const store = await loadStore();
      return { ok: true, settings: store.settings };
    }
    case 'SET_SETTINGS': {
      const store = await loadStore();
      const settings = mergeSettingsPatch(store.settings, msg.settings);
      await savePartial({ settings });
      await ensureAlarms(settings.autoRefresh);
      return { ok: true, settings };
    }
    case 'GET_LIST': {
      const store = await loadStore();
      return { ok: true, list: store.list, source: store.listSource, fetchedAt: store.listFetchedAt };
    }
    case 'SET_LIST': {
      const list = sanitizeList(msg.list);
      await persistList(list, msg.source);
      return { ok: true, list, source: msg.source, fetchedAt: Date.now() };
    }
    case 'REFRESH_LIST': {
      // Return proposed list + diff; do not persist until PREVIEW_DIFF_CONFIRM
      const store = await loadStore();
      let list;
      let warnings: string[] = [];
      let source: 'url' | 'seed' = 'seed';
      if (store.settings.listUrl) {
        const r = await fetchRemoteList(store.settings.listUrl);
        list = r.list;
        warnings = r.warnings;
        source = 'url';
      } else {
        const r = await loadBundledSeed();
        list = r.list;
        warnings = r.warnings;
      }
      const diff = diffLists(store.list?.entries ?? [], list.entries);
      await chrome.storage.session.set({
        pendingList: list,
        pendingListSource: source,
        pendingAddedKeys: diff.addedKeys,
      });
      return {
        ok: true,
        list,
        source,
        fetchedAt: Date.now(),
        warnings: [
          ...warnings,
          `Diff : +${diff.added.length} / −${diff.removed.length}. Confirmez pour appliquer.`,
        ],
      };
    }
    case 'PREVIEW_DIFF_CONFIRM': {
      const list = sanitizeList(msg.list);
      await persistList(list, msg.source);
      await chrome.storage.session.set({ lastAddedKeys: msg.addedKeys ?? [] });
      return { ok: true, list, source: msg.source, fetchedAt: Date.now() };
    }
    case 'GET_WHITELIST': {
      const store = await loadStore();
      return { ok: true, whitelist: store.whitelist };
    }
    case 'SET_WHITELIST': {
      const whitelist = sanitizeEntries(msg.whitelist, 2000);
      await savePartial({ whitelist });
      return { ok: true, whitelist };
    }
    case 'ADD_WHITELIST': {
      const store = await loadStore();
      const keys = new Set(store.whitelist.flatMap((e) => entryKeys(e)));
      const next = store.whitelist.slice();
      for (const e of sanitizeEntries(msg.entries, 100)) {
        const k = entryKey(e);
        if (!k || keys.has(k)) continue;
        next.push(e);
        for (const kk of entryKeys(e)) keys.add(kk);
      }
      await savePartial({ whitelist: next });
      return { ok: true, whitelist: next };
    }
    case 'REMOVE_WHITELIST': {
      const store = await loadStore();
      const remove = new Set(msg.keys);
      const next = store.whitelist.filter((e) => !entryKeys(e).some((k) => remove.has(k)));
      await savePartial({ whitelist: next });
      return { ok: true, whitelist: next };
    }
    case 'BUILD_PREVIEW': {
      const entries = msg.entries ? sanitizeEntries(msg.entries) : undefined;
      const preview = await buildPreviewSnapshot(entries, msg.excludeFollowingByDefault !== false, {
        precheckNone: !!msg.precheckNone,
        newlyAddedKeys: msg.newlyAddedKeys,
      });
      return { ok: true, preview };
    }
    case 'START_QUEUE': {
      const store = await loadStore();
      const action = msg.action ?? 'block';
      let items = sanitizeQueueItems(msg.items);
      if (action === 'block') {
        // Filtrage anticipé ; la file revérifie chaque compte résolu avant blocage.
        let self = peekSelf();
        if (!self) {
          try {
            self = await getSelf(await openXSession());
          } catch {
            /* la file refusera de bloquer tant que le compte n'est pas identifié */
          }
        }
        items = filterAgainstWhitelist(items, store.whitelist, self);
      }
      const { queue, added } = enqueue(store.queue, items, action);
      // Nouveau lot sur une file vide : la barre « X / N » repart de zéro.
      const run = store.queue.length === 0 ? startBatch(store.run) : store.run;
      await savePartial({ queue, run });
      await startQueue();
      return { ok: true, added, queueLength: queue.length };
    }
    case 'PAUSE_QUEUE':
      await pauseQueue();
      return { ok: true, status: await statusSnapshot() };
    case 'RESUME_QUEUE':
      await startQueue();
      return { ok: true, status: await statusSnapshot() };
    case 'CLEAR_QUEUE': {
      await pauseQueue();
      const store = await loadStore();
      await savePartial({ queue: [], run: { ...store.run, batchDone: 0, batchSkipped: 0, batchSmall: 0, batchStartedAt: null, nextActionAt: null } });
      return { ok: true, added: 0, queueLength: 0 };
    }
    case 'UNDO_EXTENSION_BLOCKS': {
      const store = await loadStore();
      const items = store.blockedByExt.map((b) => ({ handle: b.handle, id: b.id }));
      const { queue, added } = enqueue(store.queue, items, 'unblock');
      const run = store.queue.length === 0 ? startBatch(store.run) : store.run;
      await savePartial({ queue, blockedByExt: [], run });
      await startQueue();
      return { ok: true, added, queueLength: queue.length };
    }
    case 'GET_LOGS': {
      const store = await loadStore();
      return { ok: true, logs: store.logs };
    }
    case 'GET_DIAGNOSTICS':
      return { ok: true, diagnostics: await loadDiag() };
    case 'CLEAR_DIAGNOSTICS':
      await clearDiag();
      return { ok: true, diagnostics: [] };
    case 'CLEAR_LOGS': {
      await savePartial({ logs: [] });
      return { ok: true, logs: [] };
    }
    case 'RESET_HISTORY': {
      const store = await loadStore();
      await savePartial({
        logs: [],
        blockedByExt: [],
        alreadyBlockedKeys: [],
        run: {
          ...store.run,
          totalDone: 0,
          totalSkipped: 0,
          totalSmall: 0,
          actionsToday: 0,
          lastError: null,
          lastActionAt: null,
          lastBlocked: null,
          batchDone: 0,
          batchSkipped: 0,
          batchSmall: 0,
          batchStartedAt: store.queue.length ? Date.now() : null,
        },
      });
      return { ok: true, status: await statusSnapshot() };
    }
    case 'OPEN_PREVIEW': {
      // En mode « list », le content script n'envoie rien : la liste stockée est lue ici.
      const store = msg.mode === 'list' ? await loadStore() : null;
      const entries = previewEntriesFor(msg, store?.list ?? null);
      const token = crypto.randomUUID();
      await chrome.storage.session.set({
        [`preview:${token}`]: {
          entries,
          label: String(msg.sourceLabel ?? '').slice(0, 120),
          precheckNone: msg.mode === 'list' ? false : msg.precheckNone !== false,
        },
      });
      // Clear legacy key
      await chrome.storage.session.remove(['previewEntries', 'previewLabel']);
      const url = chrome.runtime.getURL(`preview.html?k=${encodeURIComponent(token)}`);
      await chrome.tabs.create({ url });
      return { ok: true, added: entries.length, queueLength: 0 };
    }
    default:
      return { ok: false, error: 'Message inconnu' };
  }
}

