import { createServer } from "node:http";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const seedTopics = JSON.parse(readFileSync(resolve(__dirname, "data/seed-topics.json"), "utf8"));
const DATA_FILE = process.env.PLUS_ONE_DATA_FILE || resolve(__dirname, "data/state.json");
const DEFAULT_PROFILE_ID = process.env.DEFAULT_PROFILE_ID || "demo";
const DATABASE_URL = process.env.DATABASE_URL || "";
const { Pool } = pg;
const pool = DATABASE_URL ? new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false }
}) : null;
let dbReady = null;

async function ensureDatabase() {
  if (!pool) return;
  if (!dbReady) {
    dbReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS plus_one_state (
          id TEXT PRIMARY KEY,
          state JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      const seed = existsSync(DATA_FILE)
        ? (() => { try { return JSON.parse(readFileSync(DATA_FILE, "utf8")); } catch { return { profiles: {}, lessons: {} }; } })()
        : { profiles: {}, lessons: {} };
      await pool.query(
        "INSERT INTO plus_one_state (id, state) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO NOTHING",
        ["global", JSON.stringify(seed)]
      );
    })();
  }
  return dbReady;
}

async function loadState() {
  if (pool) {
    await ensureDatabase();
    const result = await pool.query("SELECT state FROM plus_one_state WHERE id = $1", ["global"]);
    return result.rows[0]?.state || { profiles: {}, lessons: {} };
  }
  if (!existsSync(DATA_FILE)) return { profiles: {}, lessons: {} };
  try { return JSON.parse(readFileSync(DATA_FILE, "utf8")); }
  catch { return { profiles: {}, lessons: {} }; }
}
async function saveState(state) {
  if (pool) {
    await ensureDatabase();
    await pool.query(
      "INSERT INTO plus_one_state (id, state, updated_at) VALUES ($1, $2::jsonb, NOW()) ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = NOW()",
      ["global", JSON.stringify(state)]
    );
    return;
  }
  mkdirSync(dirname(DATA_FILE), { recursive: true });
  writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
}
function profileFor(state, id) {
  if (!state.profiles[id]) {
    state.profiles[id] = {
      id,
      interests: [],
      goals: [],
      avoidTopics: [],
      completedTopicIds: [],
      recentTopicIds: [],
      capabilities: [],
      feedback: [],
      updatedAt: new Date().toISOString()
    };
  }
  return state.profiles[id];
}
function words(s = "") {
  return new Set(String(s).toLowerCase().match(/[a-z0-9+#.-]+/g) || []);
}
function hashString(input = "") {
  let h = 2166136261;
  for (const ch of String(input)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function scoreTopic(topic, profile, contextSummary = "", stableKey = "") {
  if (profile.completedTopicIds.includes(topic.id)) return -10000;
  if (profile.recentTopicIds.includes(topic.id)) return -5000;
  const avoid = new Set(profile.avoidTopics.map(x => x.toLowerCase()));
  if (topic.tags.some(t => avoid.has(t.toLowerCase()))) return -1000;

  const contextWords = words(contextSummary);
  const profileWords = words([...profile.interests, ...profile.goals].join(" "));
  let score = (hashString(`${stableKey}:${topic.id}`) % 2000) / 1000;
  for (const tag of topic.tags) {
    const t = tag.toLowerCase();
    if (profileWords.has(t)) score += 5;
    if (contextWords.has(t)) score += 7;
  }
  for (const token of words(topic.title + " " + topic.why)) {
    if (profileWords.has(token)) score += 0.8;
    if (contextWords.has(token)) score += 1.2;
  }
  if (topic.tags.includes("life") || topic.tags.includes("safety")) score += 1.5;
  return score;
}
function chooseTopic(profile, contextSummary = "", stableKey = "") {
  const ranked = seedTopics
    .map(t => ({ topic: t, score: scoreTopic(t, profile, contextSummary, stableKey) }))
    .sort((a,b) => b.score - a.score);
  const pool = ranked.slice(0, Math.min(5, ranked.length));
  if (!pool.length) return seedTopics[0];
  return pool[hashString(stableKey) % pool.length].topic;
}
function makeLessonId(day, topicId) {
  return `${day}:${topicId}`;
}

function createPlusOneServer() {
  const server = new McpServer(
    { name: "plus-one-daily", version: "0.2.0" },
    { instructions: "Choose one useful lesson at a time. Keep raw private conversation text out of plugin storage; use only concise user-approved learning-profile summaries." }
  );

  server.registerTool(
    "update_learning_profile",
    {
      title: "Update learning profile",
      description: "Store a concise, user-approved learning profile such as interests, goals, and topics to avoid. Do not pass raw chat transcripts.",
      inputSchema: {
        profile_id: z.string().min(1).optional(),
        interests: z.array(z.string()).max(30).optional(),
        goals: z.array(z.string()).max(20).optional(),
        avoid_topics: z.array(z.string()).max(30).optional()
      },
      outputSchema: {
        profile_id: z.string(),
        interests: z.array(z.string()),
        goals: z.array(z.string()),
        avoid_topics: z.array(z.string())
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
    },
    async ({ profile_id, interests, goals, avoid_topics }) => {
      const state = await loadState();
      const id = profile_id || DEFAULT_PROFILE_ID;
      const p = profileFor(state, id);
      if (interests) p.interests = [...new Set(interests.map(x => x.trim()).filter(Boolean))];
      if (goals) p.goals = [...new Set(goals.map(x => x.trim()).filter(Boolean))];
      if (avoid_topics) p.avoidTopics = [...new Set(avoid_topics.map(x => x.trim()).filter(Boolean))];
      p.updatedAt = new Date().toISOString();
      await saveState(state);
      const out = { profile_id: id, interests: p.interests, goals: p.goals, avoid_topics: p.avoidTopics };
      return { structuredContent: out, content: [{ type: "text", text: "Updated the +1 learning profile." }] };
    }
  );

  server.registerTool(
    "get_daily_plus_one",
    {
      title: "Get today's +1",
      description: "Choose one useful personalised topic for today's short learning experience, avoiding recent or completed topics.",
      inputSchema: {
        profile_id: z.string().min(1).optional(),
        context_summary: z.string().max(2000).optional(),
        preferred_minutes: z.number().int().min(2).max(15).optional(),
        local_date: z.string().regex(/^\\d{4}-\\d{2}-\\d{2}$/).optional()
      },
      outputSchema: {
        lesson_id: z.string(),
        title: z.string(),
        hook_seed: z.string(),
        learning_outcome: z.string(),
        why_useful: z.string(),
        estimated_minutes: z.number(),
        tags: z.array(z.string())
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
    },
    async ({ profile_id, context_summary = "", preferred_minutes, local_date }) => {
      const state = await loadState();
      const id = profile_id || DEFAULT_PROFILE_ID;
      const p = profileFor(state, id);
      const day = local_date || new Date().toISOString().slice(0,10);
      state.lessons[id] ||= {};
      const existingTopicId = state.lessons[id][day]?.topicId;
      let topic = existingTopicId ? seedTopics.find(t => t.id === existingTopicId) : null;
      if (!topic) topic = chooseTopic(p, context_summary, `${id}:${day}`);
      if (!existingTopicId && preferred_minutes) {
        const candidates = seedTopics.filter(t => !p.completedTopicIds.includes(t.id) && Math.abs(t.minutes - preferred_minutes) <= 2);
        if (candidates.length) {
          const stableKey = `${id}:${day}:minutes`;
          const ranked = candidates.map(t => ({ topic:t, score:scoreTopic(t,p,context_summary,stableKey) })).sort((a,b)=>b.score-a.score);
          topic = ranked[hashString(stableKey) % Math.min(4, ranked.length)].topic;
        }
      }
      state.lessons[id][day] = { topicId: topic.id, selectedAt: new Date().toISOString() };
      await saveState(state);
      const out = {
        lesson_id: makeLessonId(day, topic.id),
        title: topic.title,
        hook_seed: `Today's +1: ${topic.title}`,
        learning_outcome: topic.outcome,
        why_useful: topic.why,
        estimated_minutes: topic.minutes,
        tags: topic.tags
      };
      return {
        structuredContent: out,
        content: [{ type: "text", text: `Today's +1 is “${topic.title}”. Teach it interactively in about ${topic.minutes} minutes and verify the learner can ${topic.outcome}.` }]
      };
    }
  );

  server.registerTool(
    "record_lesson_result",
    {
      title: "Record +1 result",
      description: "Record completion, feedback and the demonstrated capability after a +1 lesson.",
      inputSchema: {
        profile_id: z.string().min(1).optional(),
        lesson_id: z.string().min(1),
        status: z.enum(["completed", "skipped", "already_knew", "not_interested"]),
        demonstrated_capability: z.string().max(500).optional(),
        rating: z.enum(["loved", "useful", "neutral", "not_for_me"]).optional(),
        tags: z.array(z.string()).max(20).optional()
      },
      outputSchema: {
        total_capabilities: z.number(),
        message: z.string()
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
    },
    async ({ profile_id, lesson_id, status, demonstrated_capability, rating, tags = [] }) => {
      const state = await loadState();
      const id = profile_id || DEFAULT_PROFILE_ID;
      const p = profileFor(state, id);
      const topicId = lesson_id.includes(":") ? lesson_id.split(":").slice(1).join(":") : lesson_id;
      p.recentTopicIds = [topicId, ...p.recentTopicIds.filter(x => x !== topicId)].slice(0, 14);
      if (["completed", "already_knew"].includes(status) && !p.completedTopicIds.includes(topicId)) p.completedTopicIds.push(topicId);
      if (status === "completed" && demonstrated_capability) {
        p.capabilities.push({ lessonId: lesson_id, capability: demonstrated_capability, completedAt: new Date().toISOString(), tags });
      }
      p.feedback.push({ lessonId: lesson_id, status, rating: rating || null, at: new Date().toISOString(), tags });
      p.feedback = p.feedback.slice(-200);
      p.updatedAt = new Date().toISOString();
      await saveState(state);
      const message = status === "completed" ? `Capability recorded: ${demonstrated_capability || "lesson completed"}` : `Recorded lesson as ${status}.`;
      const out = { total_capabilities: p.capabilities.length, message };
      return { structuredContent: out, content: [{ type: "text", text: message }] };
    }
  );

  server.registerTool(
    "get_capability_passport",
    {
      title: "Get capability passport",
      description: "Review the user's completed +1 capabilities and recent learning history.",
      inputSchema: { profile_id: z.string().min(1).optional(), limit: z.number().int().min(1).max(100).optional() },
      outputSchema: {
        total_capabilities: z.number(),
        capabilities: z.array(z.object({ capability: z.string(), completedAt: z.string(), tags: z.array(z.string()) }))
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async ({ profile_id, limit = 25 }) => {
      const state = await loadState();
      const id = profile_id || DEFAULT_PROFILE_ID;
      const p = profileFor(state, id);
      const caps = [...p.capabilities].reverse().slice(0, limit).map(c => ({ capability:c.capability, completedAt:c.completedAt, tags:c.tags || [] }));
      const out = { total_capabilities: p.capabilities.length, capabilities: caps };
      return { structuredContent: out, content: [{ type: "text", text: `You have ${p.capabilities.length} recorded +1 capabilities.` }] };
    }
  );

  server.registerTool(
    "export_learning_data",
    {
      title: "Export my +1 data",
      description: "Return the learning profile, lesson selections, feedback and capability history stored for one +1 profile.",
      inputSchema: { profile_id: z.string().min(1).optional() },
      outputSchema: {
        profile_id: z.string(),
        profile: z.any(),
        lessons: z.any()
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async ({ profile_id }) => {
      const state = await loadState();
      const id = profile_id || DEFAULT_PROFILE_ID;
      const p = profileFor(state, id);
      const out = { profile_id: id, profile: p, lessons: state.lessons[id] || {} };
      return {
        structuredContent: out,
        content: [{ type: "text", text: "Here is the +1 learning data stored for this profile. +1 does not store raw ChatGPT conversation transcripts." }]
      };
    }
  );

  server.registerTool(
    "delete_learning_data",
    {
      title: "Delete my +1 data",
      description: "Permanently delete the stored +1 learning profile, lesson history, feedback and Capability Passport for one profile.",
      inputSchema: {
        profile_id: z.string().min(1).optional(),
        confirm: z.literal(true)
      },
      outputSchema: {
        deleted: z.boolean(),
        profile_id: z.string()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
    },
    async ({ profile_id, confirm }) => {
      if (confirm !== true) throw new Error("Deletion requires explicit confirmation.");
      const state = await loadState();
      const id = profile_id || DEFAULT_PROFILE_ID;
      const existed = Boolean(state.profiles[id] || state.lessons[id]);
      delete state.profiles[id];
      delete state.lessons[id];
      await saveState(state);
      const out = { deleted: existed, profile_id: id };
      return {
        structuredContent: out,
        content: [{ type: "text", text: existed ? "Your +1 learning data was deleted." : "No stored +1 learning data was found for that profile." }]
      };
    }
  );

  return server;
}

const port = Number(process.env.PORT ?? 8787);
const MCP_PATH = "/mcp";
const httpServer = createServer(async (req, res) => {
  if (!req.url) return res.writeHead(400).end("Missing URL");
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "OPTIONS" && url.pathname === MCP_PATH) {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "content-type, mcp-session-id",
      "Access-Control-Expose-Headers": "Mcp-Session-Id"
    });
    return res.end();
  }
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ name: "+1 Daily MCP", status: "ok", version: "0.3.0", storage: pool ? "postgres" : "temporary-file" }));
  }

  const MCP_METHODS = new Set(["POST", "GET", "DELETE"]);
  if (url.pathname === MCP_PATH && req.method && MCP_METHODS.has(req.method)) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
    const server = createPlusOneServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("MCP request error:", error);
      if (!res.headersSent) res.writeHead(500).end("Internal server error");
    }
    return;
  }
  res.writeHead(404).end("Not Found");
});

httpServer.listen(port, "0.0.0.0", () => console.log(`+1 Daily MCP listening on 0.0.0.0:${port}${MCP_PATH}`));
