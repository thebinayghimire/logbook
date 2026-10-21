"use strict";

/**
 * Release Notes & Engineering Digest Synthesis Engine.
 *
 * Categorizes commit messages using Conventional Commits heuristics
 * and formats clean, publication-ready Markdown release notes and weekly digests.
 */

function categorizeCommits(commits) {
  const groups = {
    features: [],
    fixes: [],
    refactoring: [],
    documentation: [],
    chores: [],
    other: []
  };

  if (!Array.isArray(commits)) return groups;

  for (const c of commits) {
    const rawMsg = typeof c === "string" ? c : (c.msg || (c.commit && c.commit.message) || "");
    const msg = rawMsg.split("\n")[0].trim();
    if (!msg) continue;

    const lower = msg.toLowerCase();
    const item = {
      message: msg,
      sha: c.sha ? String(c.sha).slice(0, 7) : "",
      repo: c.repo || "",
      author: c.author || ""
    };

    if (/^feat(\([\w\-\.]+\))?:/i.test(lower) || lower.startsWith("add ") || lower.startsWith("added ")) {
      groups.features.push(item);
    } else if (/^fix(\([\w\-\.]+\))?:/i.test(lower) || lower.startsWith("fix ") || lower.startsWith("fixed ") || lower.includes("bugfix")) {
      groups.fixes.push(item);
    } else if (/^refactor(\([\w\-\.]+\))?:/i.test(lower) || /^perf(\([\w\-\.]+\))?:/i.test(lower) || lower.startsWith("clean ") || lower.startsWith("cleanup ")) {
      groups.refactoring.push(item);
    } else if (/^docs?(\([\w\-\.]+\))?:/i.test(lower) || lower.includes("readme") || lower.startsWith("document ")) {
      groups.documentation.push(item);
    } else if (/^chore(\([\w\-\.]+\))?:/i.test(lower) || /^test(\([\w\-\.]+\))?:/i.test(lower) || /^ci(\([\w\-\.]+\))?:/i.test(lower) || lower.startsWith("bump ") || lower.startsWith("update ")) {
      groups.chores.push(item);
    } else {
      groups.other.push(item);
    }
  }

  return groups;
}

function generateMarkdownDigest(grouped, options = {}) {
  const title = options.title || "Weekly Engineering Ledger & Release Notes";
  const dateStr = new Date().toISOString().slice(0, 10);
  let md = "# " + title + "\n\n*Compiled on " + dateStr + " via Logbook Telemetry*\n\n";

  function renderSection(name, emoji, items) {
    if (!items || !items.length) return "";
    let sec = "### " + emoji + " " + name + " (" + items.length + ")\n";
    for (const it of items) {
      const shaStr = it.sha ? " (`" + it.sha + "`)" : "";
      const repoStr = it.repo ? "**[" + it.repo + "]** " : "";
      sec += "- " + repoStr + it.message + shaStr + "\n";
    }
    return sec + "\n";
  }

  md += renderSection("New Features & Capabilities", "✨", grouped.features);
  md += renderSection("Bug Fixes & Hardening", "🐛", grouped.fixes);
  md += renderSection("Refactoring & Performance", "⚡", grouped.refactoring);
  md += renderSection("Documentation", "📚", grouped.documentation);
  md += renderSection("Chores & Maintenance", "🔧", grouped.chores);
  md += renderSection("Other Updates", "📦", grouped.other);

  const total = (grouped.features.length + grouped.fixes.length + grouped.refactoring.length +
                 grouped.documentation.length + grouped.chores.length + grouped.other.length);
  md += "---\n\n**Summary:** " + total + " total commits synthesized across active repositories.\n";

  return md;
}

module.exports = {
  categorizeCommits,
  generateMarkdownDigest
};
