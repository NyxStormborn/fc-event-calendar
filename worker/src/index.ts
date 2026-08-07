type WorkerEnv = Cloudflare.Env & {
  FC_ACCESS_CODE: string;
  RAID_HELPER_WEBHOOK_KEY: string;
  RAID_HELPER_API_KEY?: string;
  RAID_HELPER_SERVER_ID: string;
  RAID_HELPER_CHANNEL_ID: string;
};

type Member = { id: string; character_name: string; world_name: string };
type EventRow = {
  id: string;
  title: string;
  description: string;
  starts_at: string;
  ends_at: string | null;
  created_by_member_id: string;
  created_at: string;
  updated_at: string;
  source: string;
  external_event_id: string | null;
  external_channel_id: string | null;
};

type RaidHelperEvent = {
  id: string;
  serverId: string;
  channelId: string;
  title: string;
  description: string;
  startTime: number;
  endTime: number;
};

type RaidHelperEventsResponse = {
  pages: number;
  postedEvents: unknown[];
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8" },
});

const fail = (message: string, status = 400) => json({ error: message }, status);
const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function matchesSecret(provided: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
}

function readText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : null;
}

async function requestBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await request.json();
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

async function memberFromRequest(request: Request, env: WorkerEnv): Promise<Member | null> {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const tokenHash = await sha256(header.slice(7));
  const member = await env.DB.prepare(
    "SELECT id, character_name, world_name FROM members WHERE token_hash = ?",
  ).bind(tokenHash).first<Member>();
  if (member) {
    await env.DB.prepare("UPDATE members SET last_seen_at = ? WHERE id = ?").bind(now(), member.id).run();
  }
  return member ?? null;
}

async function eventDetails(env: WorkerEnv, event: EventRow) {
  const registrations = await env.DB.prepare(
    "SELECT character_name AS characterName, world_name AS worldName, registered_at AS registeredAt " +
    "FROM registrations WHERE event_id = ? ORDER BY registered_at ASC",
  ).bind(event.id).all();

  return {
    id: event.id,
    title: event.title,
    description: event.description,
    startsAt: event.starts_at,
    endsAt: event.ends_at,
    createdByMemberId: event.created_by_member_id,
    createdAt: event.created_at,
    updatedAt: event.updated_at,
    source: event.source,
    registrations: registrations.results,
  };
}

function readRaidHelperEvent(body: Record<string, unknown>): RaidHelperEvent | null {
  const id = readText(body.id, 32);
  const serverId = readText(body.serverId, 32);
  const channelId = readText(body.channelId, 32);
  const title = readText(body.title, 120);
  const description = typeof body.description === "string" && body.description.length <= 2000 ? body.description.trim() : "";
  const startTime = typeof body.startTime === "number" && Number.isFinite(body.startTime) ? body.startTime : NaN;
  const endTime = typeof body.endTime === "number" && Number.isFinite(body.endTime) ? body.endTime : NaN;
  if (!id || !serverId || !channelId || !title || Number.isNaN(startTime)) return null;
  return { id, serverId, channelId, title, description, startTime, endTime };
}

function isoFromUnixSeconds(value: number): string | null {
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function upsertRaidHelperEvent(env: WorkerEnv, event: RaidHelperEvent): Promise<void> {
  if (event.serverId !== env.RAID_HELPER_SERVER_ID || event.channelId !== env.RAID_HELPER_CHANNEL_ID)
    throw new Error("Event is not from the configured Raid Helper channel.");

  const startsAt = isoFromUnixSeconds(event.startTime);
  const endsAt = Number.isNaN(event.endTime) ? null : isoFromUnixSeconds(event.endTime);
  if (!startsAt || (event.endTime && !endsAt)) throw new Error("Raid Helper event has invalid timestamps.");

  const timestamp = now();
  await env.DB.prepare(
    "INSERT INTO events (id, title, description, starts_at, ends_at, created_by_member_id, created_at, updated_at, source, external_event_id, external_channel_id) " +
    "VALUES (?, ?, ?, ?, ?, 'raid-helper', ?, ?, 'raid-helper', ?, ?) " +
    "ON CONFLICT(external_event_id) DO UPDATE SET title = excluded.title, description = excluded.description, starts_at = excluded.starts_at, ends_at = excluded.ends_at, updated_at = excluded.updated_at, external_channel_id = excluded.external_channel_id",
  ).bind(id(), event.title, event.description, startsAt, endsAt, timestamp, timestamp, event.id, event.channelId).run();
}

async function syncRaidHelperEvents(env: WorkerEnv): Promise<number> {
  const apiKey = env.RAID_HELPER_API_KEY?.trim();
  if (!apiKey) return 0;

  let imported = 0;
  for (let page = 1; page <= 50; page++) {
    const response = await fetch(`https://raid-helper.xyz/api/v4/servers/${env.RAID_HELPER_SERVER_ID}/events`, {
      headers: {
        Authorization: apiKey,
        Page: String(page),
        ChannelFilter: env.RAID_HELPER_CHANNEL_ID,
      },
    });
    if (!response.ok) throw new Error(`Raid Helper API returned ${response.status}.`);

    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid Raid Helper API response.");
    const data = payload as Partial<RaidHelperEventsResponse>;
    if (!Array.isArray(data.postedEvents)) throw new Error("Raid Helper API response contains no events.");

    for (const rawEvent of data.postedEvents) {
      if (!rawEvent || typeof rawEvent !== "object" || Array.isArray(rawEvent)) continue;
      const event = readRaidHelperEvent(rawEvent as Record<string, unknown>);
      if (!event || event.serverId !== env.RAID_HELPER_SERVER_ID || event.channelId !== env.RAID_HELPER_CHANNEL_ID) continue;
      await upsertRaidHelperEvent(env, event);
      imported++;
    }

    const pages = typeof data.pages === "number" && Number.isInteger(data.pages) && data.pages > 0 ? data.pages : page;
    if (page >= pages) break;
  }
  return imported;
}

async function handleRaidHelperWebhook(request: Request, env: WorkerEnv, action: "create" | "update" | "delete"): Promise<Response> {
  const authorization = request.headers.get("authorization");
  if (!authorization || !(await matchesSecret(authorization, env.RAID_HELPER_WEBHOOK_KEY))) return fail("Unauthorized webhook.", 401);
  const body = await requestBody(request);
  const eventId = body ? readText(body.id, 32) : null;
  if (!body || !eventId) return fail("Invalid Raid Helper webhook payload.");

  if (action === "delete") {
    await env.DB.prepare("DELETE FROM events WHERE source = 'raid-helper' AND external_event_id = ?").bind(eventId).run();
    return json({ ok: true });
  }

  const event = readRaidHelperEvent(body);
  if (!event) return fail("Invalid Raid Helper event payload.");
  try {
    await upsertRaidHelperEvent(env, event);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Could not import Raid Helper event.", 400);
  }
  return json({ ok: true });
}

async function removeExpiredEvents(env: WorkerEnv): Promise<void> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // Remove registrations explicitly before their event. This keeps cleanup safe
  // even if foreign-key enforcement is changed in a future database migration.
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM registrations WHERE event_id IN (SELECT id FROM events WHERE starts_at <= ?)",
    ).bind(cutoff),
    env.DB.prepare("DELETE FROM events WHERE starts_at <= ?").bind(cutoff),
  ]);
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "") || "/";

    if (request.method === "GET" && path === "/health") return json({ ok: true });

    if (request.method === "POST" && path === "/v1/integrations/raid-helper/event.create")
      return handleRaidHelperWebhook(request, env, "create");
    if (request.method === "POST" && (path === "/v1/integrations/raid-helper/event.update" || path === "/v1/integrations/raid-helper/event.edit"))
      return handleRaidHelperWebhook(request, env, "update");
    if (request.method === "POST" && path === "/v1/integrations/raid-helper/event.delete")
      return handleRaidHelperWebhook(request, env, "delete");

    if (request.method === "POST" && path === "/v1/enroll") {
      const body = await requestBody(request);
      const accessCode = body ? readText(body.accessCode, 200) : null;
      const characterName = body ? readText(body.characterName, 80) : null;
      const worldName = body ? readText(body.worldName, 80) : null;
      if (!accessCode || !characterName || !worldName) return fail("Access code, character name, and world are required.");
      if (!(await matchesSecret(accessCode, env.FC_ACCESS_CODE))) return fail("Invalid FC access code.", 401);

      const token = crypto.getRandomValues(new Uint8Array(32));
      const deviceToken = btoa(String.fromCharCode(...token)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
      const timestamp = now();
      const memberId = id();
      await env.DB.prepare(
        "INSERT INTO members (id, token_hash, character_name, world_name, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind(memberId, await sha256(deviceToken), characterName, worldName, timestamp, timestamp).run();
      return json({ deviceToken, member: { id: memberId, characterName, worldName } }, 201);
    }

    const member = await memberFromRequest(request, env);
    if (!member) return fail("Not connected.", 401);

    if (request.method === "GET" && path === "/v1/me") {
      return json({ member: { id: member.id, characterName: member.character_name, worldName: member.world_name } });
    }

    if (request.method === "GET" && path === "/v1/events") {
      const importedEvents = await env.DB.prepare("SELECT COUNT(*) AS count FROM events WHERE source = 'raid-helper'").first<{ count: number }>();
      if ((importedEvents?.count ?? 0) === 0) {
        try {
          await syncRaidHelperEvents(env);
        } catch (error) {
          console.error("Initial Raid Helper sync failed", error);
        }
      }
      const from = url.searchParams.get("from") ?? "0000-01-01T00:00:00.000Z";
      const until = url.searchParams.get("until") ?? "9999-12-31T23:59:59.999Z";
      const events = await env.DB.prepare(
        "SELECT * FROM events WHERE starts_at >= ? AND starts_at <= ? ORDER BY starts_at ASC",
      ).bind(from, until).all<EventRow>();
      return json({ events: await Promise.all(events.results.map((event) => eventDetails(env, event))) });
    }

    if (request.method === "POST" && path === "/v1/events") {
      const body = await requestBody(request);
      const title = body ? readText(body.title, 120) : null;
      const description = body && typeof body.description === "string" && body.description.length <= 2000 ? body.description.trim() : null;
      const startsAt = body ? readText(body.startsAt, 40) : null;
      const endsAt = body?.endsAt === null || body?.endsAt === undefined ? null : readText(body.endsAt, 40);
      if (!title || description === null || !startsAt || Number.isNaN(Date.parse(startsAt)) || (endsAt && Number.isNaN(Date.parse(endsAt)))) {
        return fail("Invalid event data.");
      }
      if (endsAt && Date.parse(endsAt) < Date.parse(startsAt)) return fail("The end time cannot be before the start time.");

      const event: EventRow = {
        id: id(), title, description, starts_at: startsAt, ends_at: endsAt,
        created_by_member_id: member.id, created_at: now(), updated_at: now(),
        source: "manual", external_event_id: null, external_channel_id: null,
      };
      await env.DB.prepare(
        "INSERT INTO events (id, title, description, starts_at, ends_at, created_by_member_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(event.id, event.title, event.description, event.starts_at, event.ends_at, event.created_by_member_id, event.created_at, event.updated_at).run();
      return json({ event: await eventDetails(env, event) }, 201);
    }

    const match = path.match(/^\/v1\/events\/([0-9a-f-]{36})(?:\/registrations)?$/i);
    if (!match) return fail("Not found.", 404);
    const eventId = match[1];
    const event = await env.DB.prepare("SELECT * FROM events WHERE id = ?").bind(eventId).first<EventRow>();
    if (!event) return fail("Event not found.", 404);

    if (request.method === "PATCH" && path === "/v1/events/" + eventId) {
      if (event.created_by_member_id !== member.id) return fail("Only the event creator can edit this event.", 403);
      const body = await requestBody(request);
      const title = body ? readText(body.title, 120) : null;
      const description = body && typeof body.description === "string" && body.description.length <= 2000 ? body.description.trim() : null;
      const startsAt = body ? readText(body.startsAt, 40) : null;
      if (!title || description === null || !startsAt || Number.isNaN(Date.parse(startsAt))) return fail("Invalid event data.");
      const updatedAt = now();
      await env.DB.prepare(
        "UPDATE events SET title = ?, description = ?, starts_at = ?, updated_at = ? WHERE id = ?",
      ).bind(title, description, startsAt, updatedAt, eventId).run();
      return json({ event: await eventDetails(env, { ...event, title, description, starts_at: startsAt, updated_at: updatedAt }) });
    }

    if (request.method === "GET" && path === `/v1/events/${eventId}`) return json({ event: await eventDetails(env, event) });

    if (request.method === "DELETE" && path === `/v1/events/${eventId}`) {
      if (event.created_by_member_id !== member.id) return fail("Only the event creator can delete this event.", 403);
      await env.DB.prepare("DELETE FROM events WHERE id = ?").bind(eventId).run();
      return new Response(null, { status: 204 });
    }

    if (request.method === "POST" && path === `/v1/events/${eventId}/registrations`) {
      const body = await requestBody(request);
      const characterName = body ? readText(body.characterName, 80) : null;
      const worldName = body ? readText(body.worldName, 80) : null;
      if (!characterName || !worldName) return fail("Character name and world are required.");
      await env.DB.prepare(
        "INSERT INTO registrations (event_id, member_id, character_name, world_name, registered_at) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(event_id, member_id) DO UPDATE SET character_name = excluded.character_name, world_name = excluded.world_name, registered_at = excluded.registered_at",
      ).bind(eventId, member.id, characterName, worldName, now()).run();
      return json({ event: await eventDetails(env, event) });
    }

    if (request.method === "DELETE" && path === `/v1/events/${eventId}/registrations`) {
      await env.DB.prepare("DELETE FROM registrations WHERE event_id = ? AND member_id = ?").bind(eventId, member.id).run();
      return new Response(null, { status: 204 });
    }

    return fail("Method not allowed.", 405);
  },
  async scheduled(_controller, env): Promise<void> {
    await removeExpiredEvents(env);
    try {
      await syncRaidHelperEvents(env);
    } catch (error) {
      console.error("Scheduled Raid Helper sync failed", error);
    }
  },
} satisfies ExportedHandler<WorkerEnv>;
