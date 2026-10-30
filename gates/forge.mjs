#!/usr/bin/env node
// One CLI over the forge layer (gates/lib/forge.mjs). Skills use it instead of gh or glab, so every
// backend serves the same verbs. Records are forge-neutral; see the header of gates/lib/forge.mjs.
// Usage: forge.mjs <verb> ... [--json] [--repo-dir <d>] [--repo <owner/name>]
//   repo                                       the repo: path, default branch, url
//   user                                       the logged-in forge user: login, name, bot
//   change view <n>                            one change in full: state, draft, head sha, branch, base, merge state,
//                                              review, author, body, autoMerge, headRepo, commits, files, mergeSha
//   change find [--head <b>] [--base <b>] [--state open|closed|merged|all]
//                                              changes from a branch and into a base (default state open)
//   change create --head <b> --base <b> --title <t> --body-file <f>
//                                              open a ready (never draft) change; prints its number and url
//   change edit <n> [--title <t>] [--body-file <f>]
//   change ready <n>                           take a change out of draft
//   change comment <n> --body-file <f>         a top-level comment on a change
//   changes merged [--limit 10]                the newest merged changes: number and title
//   checks <sha>                               the newest check of each name on a commit: name, state, url
//   checks rerun <sha>                         re-run the failed checks on a commit once, where the forge can
//   threads <n> [--open]                       review threads on a change; --open keeps the unresolved ones
//   reviews <n>                                reviews and top-level comments on a change, oldest first
//   thread reply <n> <thread> --body-file <f>  reply on a review thread
//   thread resolve <n> <thread>                resolve a review thread
//   issue view <n>                             one issue: title, state, labels, author, body, comments with authors
//   issue list [--label <l>] [--search <s>] [--in body|title] [--state open|closed|all] [--limit 200]
//   issue create --title <t> --body-file <f> [--label <l>]
//                                              prints the new issue's number and url
//   issue edit <n> [--add-label <l,...>] [--remove-label <l,...>]
//   issue comment <n> --body-file <f>
//   labels ensure <name...> [--color <hex>] [--description <d>]
//                                              create each label, or update it when it exists
//   required-checks <branch>                   required check names from the forge's branch rules; none is empty
// There is no merge verb: only gates/check-merge.mjs merges.
// --json prints the record as JSON; otherwise short readable lines.
// Exit 0 on success, 1 when the forge command fails, 2 on usage errors.
import path from "node:path";
import { main, parseArgs, UsageError, loadConfig } from "./lib/common.mjs";
import { openForge } from "./lib/forge.mjs";

const say = (line) => process.stdout.write(`${line}\n`);
const short = (sha) => String(sha).slice(0, 12);
const STATES = { change: ["open", "closed", "merged", "all"], issue: ["open", "closed", "all"] };

class ForgeFailed extends Error {}
const ok = (r, what) => {
  if (!r.ok) throw new ForgeFailed(`${what} failed: ${r.error}`);
  return r;
};

function configFrom(dir) {
  try {
    return loadConfig(path.resolve(dir)).config;
  } catch {
    return {};
  }
}

const num = (v, usage) => {
  if (!/^\d+$/.test(String(v))) throw new UsageError(`usage: forge.mjs ${usage}`);
  return Number(v);
};
const need = (v, usage) => {
  if (!v) throw new UsageError(`usage: forge.mjs ${usage}`);
  return v;
};
const oneOf = (v, list, flag) => {
  if (!list.includes(v)) throw new UsageError(`--${flag} must be one of ${list.join(", ")}`);
  return v;
};
const changeLine = (c) => `#${c.id} ${c.state}${c.draft ? " draft" : ""} ${c.branch} -> ${c.base} head ${short(c.head)} merge ${c.merge} ${c.url}`;

// Verbs that only read; everything else writes to the forge.
const READ_ONLY = new Set(["repo", "user", "change view", "change find", "changes merged", "checks", "threads", "reviews", "issue view", "issue list", "required-checks"]);

// Each verb returns [record, lines]. Arguments are checked before the forge is called.
function verb(forge, a, rest) {
  const [w1, w2, w3, w4] = rest;
  const key = ["change", "changes", "thread", "issue", "labels", "checks"].includes(w1) && !(w1 === "checks" && w2 !== "rerun") ? `${w1} ${w2}` : w1;
  const extra = (n) => {
    if (rest.length > n) throw new UsageError(`unexpected arguments: ${rest.slice(n).join(" ")}`);
  };
  switch (key) {
    case "repo": {
      extra(1);
      const r = forge.repoInfo();
      return [r, [`${r.path} default ${r.defaultBranch} ${r.url}`]];
    }
    case "user": {
      extra(1);
      const u = forge.currentUser();
      return [u, [`${u.login}${u.bot ? " (bot)" : ""}`]];
    }
    case "change view": {
      extra(3);
      const c = forge.changeDetail(num(w3, "change view <n>"));
      return [c, [changeLine(c), `title: ${c.title}`, `author: ${c.author}${c.bot ? " (bot)" : ""}; review ${c.review}${c.reviewRequired ? " (required)" : ""}; auto-merge ${c.autoMerge ? "on" : "off"}; commits ${c.commits}`]];
    }
    case "change find": {
      extra(2);
      const cs = forge.findChanges({ head: a.head ?? null, base: a.base ?? null, state: oneOf(a.state ?? "open", STATES.change, "state") });
      return [cs, cs.length ? cs.map(changeLine) : ["no changes"]];
    }
    case "change create": {
      extra(2);
      const usage = "change create --head <b> --base <b> --title <t> --body-file <f>";
      const r = ok(forge.createChange({ head: need(a.head, usage), base: need(a.base, usage), title: need(a.title, usage), bodyFile: need(a["body-file"], usage) }), "change create");
      return [r, [`#${r.id} ${r.url}`]];
    }
    case "change edit": {
      extra(3);
      const n = num(w3, "change edit <n> [--title t] [--body-file f]");
      need(a.title || a["body-file"], "change edit <n> [--title t] [--body-file f]");
      return [ok(forge.editChange(n, { title: a.title ?? null, bodyFile: a["body-file"] ?? null }), "change edit"), [`edited #${n}`]];
    }
    case "change ready": {
      extra(3);
      const n = num(w3, "change ready <n>");
      return [ok(forge.markReady(n), "change ready"), [`#${n} ready`]];
    }
    case "change comment": {
      extra(3);
      const n = num(w3, "change comment <n> --body-file f");
      return [ok(forge.commentChange(n, need(a["body-file"], "change comment <n> --body-file f")), "change comment"), [`commented on #${n}`]];
    }
    case "changes merged": {
      extra(2);
      const cs = forge.recentMerged(num(a.limit ?? 10, "changes merged [--limit n]"));
      return [cs, cs.map((c) => `#${c.id} ${c.title}`)];
    }
    case "checks": {
      extra(2);
      const cs = forge.checks(need(w2, "checks <sha>"));
      return [cs, cs.length ? cs.map((c) => `${c.state} ${c.name} ${c.url ?? ""}`.trimEnd()) : ["no checks"]];
    }
    case "checks rerun": {
      extra(3);
      const failed = forge.checks(need(w3, "checks rerun <sha>")).filter((c) => c.state === "fail");
      const handles = [...new Set(failed.map((c) => forge.rerunHandle(c)).filter(Boolean))];
      const rerun = handles.filter((h) => forge.rerun(h).ok);
      const r = { failed: failed.map((c) => c.name), rerun, skipped: handles.filter((h) => !rerun.includes(h)) };
      if (r.skipped.length) throw new ForgeFailed(`rerun failed for ${r.skipped.join(", ")}`);
      return [r, [failed.length ? `re-ran ${rerun.length} run(s) for ${r.failed.join(", ")}` : "no failed checks"]];
    }
    case "threads": {
      extra(2);
      const ts = forge.threads(num(w2, "threads <n> [--open]")).filter((t) => !a.open || !t.resolved);
      return [ts, ts.length ? ts.map((t) => `${t.resolved ? "resolved" : "open"} ${t.id} ${t.path}:${t.line} ${t.author}${t.bot ? " (bot)" : ""}: ${t.body.split("\n")[0]}`) : ["no threads"]];
    }
    case "reviews": {
      extra(2);
      const rs = forge.reviews(num(w2, "reviews <n>"));
      return [rs, rs.length ? rs.map((r) => `${r.kind}${r.state ? ` ${r.state}` : ""} ${r.author}${r.bot ? " (bot)" : ""}: ${r.body.split("\n")[0]}`) : ["no reviews"]];
    }
    case "thread reply": {
      extra(4);
      const usage = "thread reply <n> <thread> --body-file f";
      const r = ok(forge.replyThread(num(w3, usage), need(w4, usage), need(a["body-file"], usage)), "thread reply");
      return [r, [`replied ${r.url}`]];
    }
    case "thread resolve": {
      extra(4);
      const usage = "thread resolve <n> <thread>";
      return [ok(forge.resolveThread(num(w3, usage), need(w4, usage)), "thread resolve"), [`resolved ${w4}`]];
    }
    case "issue view": {
      extra(3);
      const i = forge.issueDetail(num(w3, "issue view <n>"));
      return [i, [`#${i.number} ${i.state} ${i.title}`, `labels: ${i.labels.join(", ") || "none"}; ${i.comments.length} comment(s); ${i.url}`]];
    }
    case "issue list": {
      extra(2);
      const is = forge.issues({
        state: oneOf(a.state ?? "open", STATES.issue, "state"),
        label: a.label ?? null,
        search: a.search ?? null,
        within: oneOf(a.in ?? "body", ["body", "title"], "in"),
        want: ["number", "title", "state", "labels", "createdAt"],
        limit: num(a.limit ?? 200, "issue list [--limit n]"),
      });
      return [is, is.length ? is.map((i) => `#${i.number} ${i.state} ${i.title}`) : ["no issues"]];
    }
    case "issue create": {
      extra(2);
      const usage = "issue create --title t --body-file f [--label l]";
      const r = ok(forge.createIssue({ title: need(a.title, usage), bodyFile: need(a["body-file"], usage), label: a.label ?? null }), "issue create");
      return [r, [`#${r.id} ${r.url}`]];
    }
    case "issue edit": {
      extra(3);
      const usage = "issue edit <n> [--add-label l] [--remove-label l]";
      const n = num(w3, usage);
      const list = (v) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);
      const change = { add: list(a["add-label"]), remove: list(a["remove-label"]) };
      if (!change.add.length && !change.remove.length) throw new UsageError(`usage: forge.mjs ${usage}`);
      return [ok(forge.relabel(n, change), "issue edit"), [`edited #${n}`]];
    }
    case "issue comment": {
      extra(3);
      const n = num(w3, "issue comment <n> --body-file f");
      return [ok(forge.comment(n, need(a["body-file"], "issue comment <n> --body-file f")), "issue comment"), [`commented on #${n}`]];
    }
    case "labels ensure": {
      const names = rest.slice(2);
      need(names.length, "labels ensure <name...> [--color hex] [--description d]");
      const r = forge.ensureLabels(names, a.color ?? null, a.description ?? null);
      if (!r.ok) throw new ForgeFailed(`labels ensure failed: ${r.failed.map((f) => `${f.name}: ${f.error}`).join("; ")}`);
      return [r, [`ensured ${r.done.join(", ")}`]];
    }
    case "required-checks": {
      extra(2);
      const names = forge.requiredChecks(need(w2, "required-checks <branch>"));
      return [names, names.length ? names : ["none"]];
    }
    default:
      throw new UsageError("usage: forge.mjs repo|user|change|changes|checks|threads|reviews|thread|issue|labels|required-checks ... (see the header)");
  }
}

main(async (argv) => {
  const a = parseArgs(argv, {
    flags: ["json", "open"],
    options: ["repo-dir", "repo", "forge", "forge-host", "head", "base", "state", "title", "body-file", "limit", "label", "search", "in", "add-label", "remove-label", "color", "description"],
  });
  const config = { ...configFrom(a["repo-dir"] ?? process.cwd()) };
  if (a.repo) config.repo = a.repo;
  // --forge and --forge-host stand in for config before setup has written it (cstack:setup-cstack).
  if (a.forge) config.forge = a.forge;
  if (a["forge-host"]) config.forge_host = a["forge-host"];
  const local = ["repo", "user"].includes(a._[0]);
  if (!config.repo && !local) throw new UsageError("no repo: run inside a cstack checkout, or pass --repo-dir or --repo <owner/name>");
  const forge = openForge(config, { cwd: path.resolve(a["repo-dir"] ?? process.cwd()) });
  // The forge layer reports its failures as UsageError, which gates turn into exit 2. Here any error
  // raised inside a forge call is a forge failure (exit 1); the CLI's own usage errors still exit 2.
  const guarded = new Proxy(forge, {
    get: (t, k) => (...x) => {
      try {
        return t[k](...x);
      } catch (err) {
        throw new ForgeFailed(err.message);
      }
    },
  });
  // The grader role reads only. Permission rules match the command text, which a moved flag can dodge, so the
  // CLI itself refuses every write verb under CSTACK_ROLE=grader.
  const w = a._.slice(0, 2).join(" ");
  const reads = READ_ONLY.has(w) || (READ_ONLY.has(a._[0]) && !(a._[0] === "checks" && a._[1] === "rerun"));
  if (process.env.CSTACK_ROLE === "grader" && !reads) throw new UsageError(`the grader role reads only; ${w} is not allowed`);
  let record, lines;
  try {
    [record, lines] = verb(guarded, a, a._);
  } catch (err) {
    if (!(err instanceof ForgeFailed)) throw err;
    process.stderr.write(`error: ${err.message}\n`);
    return 1;
  }
  if (a.json) say(JSON.stringify(record, null, 2));
  else for (const l of lines) say(l);
  return 0;
});
