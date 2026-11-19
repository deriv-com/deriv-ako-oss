// The Slack bot: `ako serve`.
//
// People @mention AKO in a channel or message it directly; it answers in the
// thread with buttons for each hand-off: pick the work, tell QA, ask for
// approval, approve or hold, archive. A request that names a project acts on
// the release that step can act on, with a button per release when several can. The release itself lives on GitHub, so
// the bot keeps no state of its own and a restart loses nothing; every button
// carries the project and tag it acts on.
//
// Approvals in Slack are checked against the Slack release managers in the
// flow file (users or user groups). A typed "approve" only shows the Approve
// button, so a message misread as an approval can't publish anything. The bot
// acts on GitHub as the AKO app.

import { openWorkspace, SetupNeeded } from "../engine/workspace.js";
import {
  readyWork,
  openRelease,
  announceRegression,
  requestApproval,
  decide,
  watchDeploy,
  archive,
  readiness,
  assertAwaitingApproval,
  assertSamePlace,
  findRelease,
  releasesFor,
  unmerged,
  ReleaseError,
} from "../engine/release.js";
import { LockedError, STATUS_TEXT, IN_FLIGHT } from "../engine/store.js";
import { slackActor, slackMentions, actorText } from "../engine/people.js";
import { aiSettings } from "../ai/provider.js";
import { understand } from "../ai/intent.js";
import { connectSocketMode } from "./socketMode.js";

const MAX_OPTIONS = 10; // Slack's limit per checkbox group
const MAX_PICKS = 5; // releases offered as buttons when several could be meant
const escape = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const short = (sha) => (sha ? sha.slice(0, 7) : "?");
const has = (project, step) => project.steps.includes(step);

export const SLACK_HELP = [
  "Here's what I can do. Mention me with:",
  "• `what's ready for <project>`",
  "• `create release for <project>`",
  "• `status of <project>`",
  "• `tell QA for <project>` (regression can start)",
  "• `request approval for <project>`",
  "• `approve <project>` or `hold <project>` (release managers)",
  "• `watch <project>` or `archive <project>`",
  "I find the release each one acts on, and ask when there are several. A tag names one: `approve production_v20261102_0`.",
].join("\n");

/** `ako serve`: connects to Slack and handles requests until stopped. */
export async function serve({ cwd = process.cwd(), env = process.env, fetch = globalThis.fetch, log = console.log, WebSocketImpl } = {}) {
  const ws = openWorkspace({ cwd, env, fetch });
  if (!ws.slack || !ws.vars.SLACK_APP_TOKEN) {
    throw new SetupNeeded("Slack isn't connected. Run `npx ako chat add slack` first.");
  }
  const me = await ws.slack.call("auth.test");
  const bot = createBot({ ws, ai: aiSettings(ws.vars), fetch, log });
  const socket = connectSocketMode({ appToken: ws.vars.SLACK_APP_TOKEN, onEnvelope: bot.handle, log, fetch, WebSocketImpl });
  await socket.start();
  log(`AKO is running in the ${me.team} workspace as @${me.user}. Ctrl+C stops it.`);
  // Runs until stopped. `docker stop` sends SIGTERM, which a process running
  // as PID 1 would otherwise ignore until it's killed.
  return new Promise((resolve) => {
    const stop = () => {
      socket.stop();
      log("Stopped.");
      resolve(0);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

export function createBot({ ws, ai = null, fetch = globalThis.fetch, log = () => {} }) {
  const slack = ws.slack;
  const post = (channel, thread, text, blocks) =>
    slack.call("chat.postMessage", { channel, text, ...(thread ? { thread_ts: thread } : {}), ...(blocks ? { blocks: JSON.stringify(blocks) } : {}) });
  const whisper = (channel, user, text, thread) =>
    slack.call("chat.postEphemeral", { channel, user, text, ...(thread ? { thread_ts: thread } : {}) });
  const replace = (channel, ts, text) => slack.call("chat.update", { channel, ts, text, blocks: JSON.stringify([section(text)]) });

  /** Where a release's messages go: its own thread once it has one. */
  async function threadFor(env, record, where) {
    const known = record.state.slack;
    if (known?.channel === where.channel) return known.thread;
    if (!known) {
      record.state.slack = { channel: where.channel, thread: where.thread };
      await env.store.save(record);
    }
    return where.thread;
  }

  async function handle(envelope) {
    if (envelope.type === "events_api") return onEvent(envelope.payload?.event ?? {});
    if (envelope.type === "interactive" && envelope.payload?.type === "block_actions") return onAction(envelope.payload);
    return undefined;
  }

  async function onEvent(event) {
    if (event.bot_id || event.subtype) return; // other bots, edits, joins
    const direct = event.type === "message" && event.channel_type === "im";
    if (event.type !== "app_mention" && !direct) return;
    const text = String(event.text ?? "").replace(/<@[A-Z0-9]+>/g, "").trim();
    const where = { channel: event.channel, thread: event.thread_ts ?? event.ts, user: event.user, direct };
    const request = await understand(text, ws.flow.projects, { ai, fetch });
    await guarded(where, () => run(request, where));
  }

  /** Runs `fn`, turning the engine's refusals into a reply instead of a crash. */
  async function guarded(where, fn, { privately = false } = {}) {
    try {
      await fn();
    } catch (error) {
      if (!(error instanceof ReleaseError || error instanceof LockedError || error instanceof SetupNeeded)) {
        log(`Error: ${error.stack ?? error.message}`);
      }
      const text = error instanceof ReleaseError || error instanceof LockedError ? `✗ ${error.message}` : `✗ Something went wrong: ${error.message}`;
      if (privately) await whisper(where.channel, where.user, text, where.thread);
      else await post(where.channel, where.thread, text);
    }
  }

  function projectFor(request, where) {
    const { projects } = ws.flow;
    if (request.project) return ws.findProject(request.project);
    if (request.tag) {
      const byPrefix = projects.filter((p) => request.tag.startsWith(p.release.tag_prefix));
      if (byPrefix.length === 1) return byPrefix[0];
    }
    const here = projects.filter((p) => p.slack.channels.includes(where.channel));
    if (here.length === 1) return here[0];
    return projects.length === 1 ? projects[0] : null;
  }

  async function run(request, where) {
    if (request.action === "help") return post(where.channel, where.thread, SLACK_HELP);
    const project = projectFor(request, where);
    if (!project) {
      return post(where.channel, where.thread, `Which project? Name it, like \`${request.action} ${ws.flow.projects[0].key}\`. Projects: ${ws.flow.projects.map((p) => `\`${p.key}\``).join(", ")}.`);
    }
    if (!where.direct && project.slack.channels.length && !project.slack.channels.includes(where.channel)) {
      return post(where.channel, where.thread, `${project.name} is handled in ${project.slack.channels.map((c) => `<#${c}>`).join(", ")}.`);
    }
    const env = await ws.envFor(project);
    const actor = slackActor(where.user);
    if (["ready", "create"].includes(request.action)) return offerWork(env, where, request.action === "create");
    if (request.action === "status") return postStatus(env, where, request.tag);

    const record = await pickRelease(env, request, where);
    if (!record) return undefined; // the person picks one with a button
    switch (request.action) {
      case "announce":
        return announce(env, record, where);
      case "request":
        return askApproval(env, record, where, actor);
      case "approve":
        return confirmApproval(env, record, where);
      case "hold":
        return answer(env, record, where, actor, "hold");
      case "watch":
        return watch(env, record, where);
      case "archive":
        return doArchive(env, record, where, actor);
      default:
        return post(where.channel, where.thread, SLACK_HELP);
    }
  }

  /** The release a request means, or null after posting a button for each release it could mean. */
  async function pickRelease(env, request, where) {
    if (request.tag) return findRelease(env, request.tag);
    const records = await releasesFor(env, request.action);
    if (records.length === 1) return records[0];
    const shown = records.slice(0, MAX_PICKS);
    const text = `Which ${escape(env.project.name)} release?${records.length > shown.length ? ` The ${shown.length} newest are below; name another by its tag.` : ""}`;
    const buttons = shown.map((r) =>
      button(r.state.tag, "ako_pick", JSON.stringify({ project: env.project.key, tag: r.state.tag, action: request.action })),
    );
    const lines = shown.map((r) => `• *${r.state.tag}*: ${STATUS_TEXT[r.state.status].toLowerCase()}, ${r.state.items.length} issue(s)`);
    await post(where.channel, where.thread, text, [section(`${text}\n${lines.join("\n")}`), { type: "actions", elements: buttons }]);
    return null;
  }

  async function offerWork(env, where, canOpen) {
    const { project } = env;
    const { items, current, waiting } = await readyWork(env);
    // Opening the open release again also retries its PRs that didn't merge.
    const retrying = current && has(project, "merge_prs") ? unmerged(current) : [];
    const value = JSON.stringify({ project: project.key });
    if (!items.length && canOpen && retrying.length) {
      const text = `Nothing new is ready in ${escape(project.name)}. ${retrying.map((i) => escape(i.ref)).join(", ")} in *${current.state.tag}* still ${retrying.length === 1 ? "has" : "have"} PRs to merge.`;
      return post(where.channel, where.thread, text, [section(text), { type: "actions", elements: [button("Retry the merges", "ako_retry", value, "primary")] }]);
    }
    if (!items.length) {
      return post(where.channel, where.thread, `Nothing new is ready in ${project.name}. Move issues to ${project.tracker.statuses.ready.join(" or ")} first.`);
    }
    const lines = items.map((i) => `• ${i.url ? `<${i.url}|${escape(i.ref)}>` : escape(i.ref)} ${escape(i.title)}`);
    if (!canOpen) return post(where.channel, where.thread, `${items.length} ready in ${project.name}:\n${lines.join("\n")}`);

    const blocks = [section(`*${items.length} ready in ${escape(project.name)}.* Untick anything that shouldn't go in.`)];
    for (let start = 0; start < items.length; start += MAX_OPTIONS) {
      const options = items.slice(start, start + MAX_OPTIONS).map((i) => ({
        text: { type: "plain_text", text: `${i.ref} ${i.title}`.slice(0, 75) },
        value: i.id,
      }));
      blocks.push({ type: "actions", block_id: `ako_items_${start}`, elements: [{ type: "checkboxes", action_id: "ako_items", options, initial_options: options }] });
    }
    // A project has one open release at a time: new work joins it.
    let label = "Open release";
    if (current) {
      label = `Add to ${current.state.tag}`;
      if (retrying.length) blocks.push(context(`This also retries the PRs of ${retrying.map((i) => escape(i.ref)).join(", ")}, which didn't merge before.`));
    } else if (waiting) {
      blocks.push(context(`${waiting.state.tag} is waiting for approval and still ships only its tested commit ${short(waiting.state.testedSha)}, so this work goes in a new release.`));
      label = "Open a new release";
    }
    blocks.push({ type: "actions", elements: [button(label, "ako_open", value, "primary")] });
    return post(where.channel, where.thread, `${items.length} ready in ${project.name}`, blocks);
  }

  async function onAction(payload) {
    const action = payload.actions?.[0];
    if (!action || action.action_id === "ako_items") return; // ticking a box needs no answer
    const channel = payload.channel?.id ?? payload.container?.channel_id;
    const where = {
      channel,
      thread: payload.message?.thread_ts ?? payload.message?.ts,
      user: payload.user?.id,
      ts: payload.message?.ts,
      direct: /^D/.test(channel ?? ""),
    };
    let value;
    try {
      value = JSON.parse(action.value);
    } catch {
      return;
    }
    const project = ws.findProject(value.project);
    if (!project) return;
    const env = await ws.envFor(project);
    const actor = slackActor(where.user);

    await guarded(
      where,
      async () => {
        if (action.action_id === "ako_pick") {
          await replace(where.channel, where.ts, `<@${where.user}> picked *${escape(value.tag)}*.`);
          return run({ action: value.action, project: value.project, tag: value.tag }, where);
        }
        if (action.action_id === "ako_retry") {
          await replace(where.channel, where.ts, `<@${where.user}> is retrying the merges…`);
          return reportOpened(env, await openRelease(env, { items: [], actor }), where);
        }
        if (action.action_id === "ako_open") {
          const picked = new Set(
            Object.entries(payload.state?.values ?? {})
              .filter(([block]) => block.startsWith("ako_items_"))
              .flatMap(([, inputs]) => (inputs.ako_items?.selected_options ?? []).map((o) => o.value)),
          );
          const { items } = await readyWork(env);
          const chosen = items.filter((i) => picked.has(i.id));
          if (!chosen.length) return whisper(where.channel, where.user, "Tick at least one issue first.", where.thread);
          await replace(where.channel, where.ts, `<@${where.user}> is opening a release with ${chosen.length} issue(s)…`);
          const result = await openRelease(env, { items: chosen, actor });
          return reportOpened(env, result, where);
        }
        const record = await findRelease(env, value.tag);
        if (action.action_id === "ako_announce") return announce(env, record, where);
        if (action.action_id === "ako_request") return askApproval(env, record, where, actor);
        if (action.action_id === "ako_approve") return answer(env, record, where, actor, "approved");
        if (action.action_id === "ako_hold") return answer(env, record, where, actor, "hold");
        if (action.action_id === "ako_archive") return doArchive(env, record, where, actor);
        return undefined;
      },
      { privately: ["ako_approve", "ako_hold"].includes(action.action_id) },
    );
  }

  async function reportOpened(env, result, where) {
    const { project } = env;
    const { record } = result;
    const thread = await threadFor(env, record, where);
    const { tag } = record.state;
    const lines = [
      !result.reused
        ? `Opened *${tag}* with ${result.added.length} issue(s). <${record.url}|Tracking issue>`
        : result.added.length
          ? `Added ${result.added.length} issue(s) to *${tag}*. <${record.url}|Tracking issue>`
          : `Retried the merges in *${tag}*. <${record.url}|Tracking issue>`,
    ];
    for (const r of result.merges?.results ?? []) {
      if (r.result === "merged") lines.push(`✓ Merged <${r.url}|PR #${r.pr}> (for ${escape(r.item)})`);
      else if (r.result === "failed") lines.push(`✗ <${r.url}|PR #${r.pr}> (for ${escape(r.item)}) not merged: ${escape(r.reason)}`);
    }
    if (result.merges?.results.some((r) => r.result === "failed")) {
      lines.push(`Fix those PRs, then mention me with \`create release for ${project.key}\` to retry them.`);
    }
    if (result.merges?.staged.length) lines.push(`Moved ${result.merges.staged.join(", ")} to ${project.tracker.statuses.staged}.`);
    if (result.merges?.withoutPrs.length) lines.push(`No linked PRs for ${result.merges.withoutPrs.join(", ")}.`);
    if (result.retested && has(project, "announce_regression")) lines.push("The new work came after the commit QA was testing, so tell QA again.");
    if (result.waiting) {
      lines.push(`${result.waiting.state.tag} is waiting for approval and still ships only its tested commit ${short(result.waiting.state.testedSha)}. This work goes out with ${tag}.`);
    }

    const value = JSON.stringify({ project: project.key, tag });
    // QA already testing what's there now needs no new word: the next step is approval.
    const next =
      has(project, "announce_regression") && record.state.status === "open"
        ? button("Tell QA regression can start", "ako_announce", value, "primary")
        : button("Ask for approval", "ako_request", value, "primary");
    return post(where.channel, thread, lines.join("\n"), [section(lines.join("\n")), { type: "actions", elements: [next] }]);
  }

  async function announce(env, record, where) {
    const { sha } = await announceRegression(env, record);
    const thread = await threadFor(env, record, where);
    const qa = slackMentions(env.project.people.qa.slack);
    const text = `${qa ? `${qa} ` : ""}Regression can start on staging for *${record.state.tag}*, at commit ${short(sha)}.\n${record.state.items.map((i) => `• ${escape(i.ref)} ${escape(i.title)}`).join("\n")}`;
    const value = JSON.stringify({ project: env.project.key, tag: record.state.tag });
    return post(where.channel, thread, text, [
      section(text),
      context(`When every issue is in ${env.project.tracker.statuses.ready_for_release}, ask for approval.`),
      { type: "actions", elements: [button("Ask for approval", "ako_request", value)] },
    ]);
  }

  async function askApproval(env, record, where, actor) {
    const result = await requestApproval(env, record, { actor });
    const thread = await threadFor(env, record, where);
    if (result.blocked) {
      return post(
        where.channel,
        thread,
        `Not everything in *${record.state.tag}* is ready for release yet:\n${result.notReady.map((i) => `• ${escape(i.ref)} ${escape(i.title)} (${escape(i.status)})`).join("\n")}`,
      );
    }
    const managers = slackMentions(env.project.people.release_managers.slack);
    const later = result.laterCommits ? `\n${result.laterCommits} commit(s) landed after the tested one; they go in the next release.` : "";
    const text = `${managers ? `${managers} ` : ""}<@${where.user}> asks to publish *${record.state.tag}* (${escape(env.project.name)}) at tested commit ${short(record.state.testedSha)}. Approve within 24 hours.${later}`;
    const value = JSON.stringify({ project: env.project.key, tag: record.state.tag });
    return post(where.channel, thread, text, [
      section(text),
      { type: "actions", elements: [button("Approve", "ako_approve", value, "primary"), button("Hold", "ako_hold", value, "danger")] },
    ]);
  }

  /** A typed approval: shows the buttons, and only a release manager's click publishes. */
  async function confirmApproval(env, record, where) {
    const { state } = record;
    assertAwaitingApproval(record, `Ask first with \`request approval for ${env.project.key}\`.`);
    assertSamePlace(record, slackActor(where.user));
    const thread = await threadFor(env, record, where);
    const text = `Publish *${state.tag}* (${escape(env.project.name)}) at tested commit ${short(state.testedSha)}? A release manager confirms with the button.`;
    const value = JSON.stringify({ project: env.project.key, tag: state.tag });
    return post(where.channel, thread, text, [
      section(text),
      { type: "actions", elements: [button("Approve", "ako_approve", value, "primary"), button("Hold", "ako_hold", value, "danger")] },
    ]);
  }

  async function answer(env, record, where, actor, verdict) {
    const result = await decide(env, record, { actor, verdict });
    const thread = await threadFor(env, record, where);
    if (where.ts) await replace(where.channel, where.ts, `${verdict === "approved" ? "Approved" : "Held"} by <@${where.user}>.`);
    if (result.held) return post(where.channel, thread, `*${record.state.tag}* is on hold.`);
    await post(where.channel, thread, `Released *${record.state.tag}*: ${result.release.html_url}`);
    if (has(env.project, "watch_deploy") && env.project.deploy.type !== "none") watch(env, record, { ...where, thread }).catch((error) => log(`Watching the deploy failed: ${error.message}`));
    return undefined;
  }

  async function watch(env, record, where) {
    if (!record.state.published) throw new ReleaseError(`\`${record.state.tag}\` isn't published yet.`);
    const thread = await threadFor(env, record, where);
    const result = await watchDeploy(env, record, {
      onEvent: (e) => {
        if (e.kind === "started") post(where.channel, thread, `Deploy started: ${e.url}`).catch(() => {});
      },
    });
    const value = JSON.stringify({ project: env.project.key, tag: record.state.tag });
    if (result.kind === "finished" && result.conclusion === "success") {
      const text = `Deployed *${record.state.tag}*: ${result.url}`;
      return post(where.channel, thread, text, has(env.project, "archive")
        ? [section(text), { type: "actions", elements: [button("Archive the release", "ako_archive", value)] }]
        : undefined);
    }
    if (result.kind === "finished") return post(where.channel, thread, `✗ The deploy of *${record.state.tag}* ended as ${result.conclusion}: ${result.url}`);
    if (result.kind === "not_found") return post(where.channel, thread, `No deploy started within 5 minutes of tagging *${record.state.tag}*. Check that the tag starts your deploy.`);
    return post(where.channel, thread, `The deploy of *${record.state.tag}* is still running after 30 minutes${result.url ? `: ${result.url}` : "."}`);
  }

  async function doArchive(env, record, where, actor) {
    const { moved } = await archive(env, record, { actor });
    const thread = await threadFor(env, record, where);
    if (where.ts) await replace(where.channel, where.ts, `Archived by <@${where.user}>.`);
    return post(where.channel, thread, `Archived *${record.state.tag}*${moved.moved ? `: moved ${moved.moved} issue(s) to ${env.project.tracker.statuses.done}` : ""}.`);
  }

  async function postStatus(env, where, tag) {
    const records = tag ? [await findRelease(env, tag)] : (await env.store.list()).slice(0, 3);
    if (!records.length) return post(where.channel, where.thread, `${env.project.name} has no releases yet.`);
    const lines = [];
    for (const record of records) {
      const { state } = record;
      lines.push(`*${state.tag}*: ${STATUS_TEXT[state.status]}, ${state.items.length} issue(s). <${record.url}|Tracking issue>`);
      if (IN_FLIGHT.has(state.status)) {
        const check = await readiness(env, record);
        lines.push(check.ready ? "  Every issue is ready for release." : check.notReady.map((i) => `  • ${escape(i.ref)} ${escape(i.title)}: ${escape(i.status)}`).join("\n"));
      }
      if (state.approval?.requestedBy && state.status === "awaiting_approval") lines.push(`  Approval asked by ${actorText(state.approval.requestedBy)}.`);
    }
    return post(where.channel, where.thread, lines.join("\n"));
  }

  return { handle, run, onAction };
}

function section(text) {
  return { type: "section", text: { type: "mrkdwn", text: text.slice(0, 3000) } };
}

function context(text) {
  return { type: "context", elements: [{ type: "mrkdwn", text }] };
}

function button(text, actionId, value, style) {
  return { type: "button", text: { type: "plain_text", text }, action_id: actionId, value, ...(style ? { style } : {}) };
}
