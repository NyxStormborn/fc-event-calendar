type WorkerEnv = Cloudflare.Env & {
  FC_ACCESS_CODE: string;
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

async function matchesAccessCode(provided: string, expected: string): Promise<boolean> {
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
    registrations: registrations.results,
  };
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

    if (request.method === "POST" && path === "/v1/enroll") {
      const body = await requestBody(request);
      const accessCode = body ? readText(body.accessCode, 200) : null;
      const characterName = body ? readText(body.characterName, 80) : null;
      const worldName = body ? readText(body.worldName, 80) : null;
      if (!accessCode || !characterName || !worldName) return fail("Access code, character name, and world are required.");
      if (!(await matchesAccessCode(accessCode, env.FC_ACCESS_CODE))) return fail("Invalid FC access code.", 401);

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

      const event: EventRow = { id: id(), title, description, starts_at: startsAt, ends_at: endsAt, created_by_member_id: member.id, created_at: now(), updated_at: now() };
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
  },
} satisfies ExportedHandler<WorkerEnv>;
