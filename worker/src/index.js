import privateFiles from "../generated/private-data.js";

const encoder = new TextEncoder();
const FILE_NAME_PATTERN = /^[^/\\\u0000-\u001f\u007f]{1,240}$/u;
const STATIC_PATHS = new Set(["/", "/index.html", "/update-index.html", "/style/ico.png"]);
const SESSION_COOKIE = "customnode_session";
const SESSION_TTL_SECONDS = 12 * 60 * 60;

function jsonResponse(body, status = 200, headers = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            ...headers,
        },
    });
}

function validFileName(fileName) {
    const hasYamlExtension = typeof fileName === "string" && fileName.toLowerCase().endsWith(".yaml");
    return (
        typeof fileName === "string" &&
        FILE_NAME_PATTERN.test(fileName) &&
        fileName !== "." &&
        fileName !== ".." &&
        !fileName.startsWith(".") &&
        (hasYamlExtension || !fileName.includes("."))
    );
}

function signingKeyIsConfigured(env) {
    return (
        typeof env.SUBSCRIPTION_SIGNING_KEY === "string" &&
        encoder.encode(env.SUBSCRIPTION_SIGNING_KEY).byteLength >= 32
    );
}

function configIsReady(env) {
    return Boolean(
        typeof env.ADMIN_PASSWORD === "string" &&
            env.ADMIN_PASSWORD.length >= 24 &&
            env.GITHUB_OWNER &&
            env.GITHUB_REPOSITORY &&
            env.GITHUB_REF &&
            signingKeyIsConfigured(env),
    );
}

function isWorkersDevHost(hostname) {
    return hostname.toLowerCase().endsWith(".workers.dev");
}

async function hmacKey(env) {
    const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(env.SUBSCRIPTION_SIGNING_KEY),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"],
    );
    return key;
}

function toBase64Url(bytes) {
    const binary = String.fromCharCode(...new Uint8Array(bytes));
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value) {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) {
        return null;
    }
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
    try {
        return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    } catch {
        return null;
    }
}

function signatureMessage(fileName, env) {
    return `subscription:v1:${env.GITHUB_OWNER}/${env.GITHUB_REPOSITORY}/${env.GITHUB_REF}/${fileName}`;
}

async function signatureFor(fileName, env) {
    const key = await hmacKey(env);
    const signature = await crypto.subtle.sign(
        "HMAC",
        key,
        encoder.encode(signatureMessage(fileName, env)),
    );
    return toBase64Url(signature);
}

async function verifySignature(fileName, signature, env) {
    const bytes = fromBase64Url(signature);
    if (!bytes || bytes.byteLength !== 32) {
        return false;
    }
    const key = await hmacKey(env);
    return crypto.subtle.verify(
        "HMAC",
        key,
        bytes,
        encoder.encode(signatureMessage(fileName, env)),
    );
}

async function createSessionCookie(env) {
    const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
    const message = `session:v1:${expiresAt}:${env.ADMIN_PASSWORD}`;
    const key = await hmacKey(env);
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
    return `${expiresAt}.${toBase64Url(signature)}`;
}

function sessionCookieValue(request) {
    const cookieHeader = request.headers.get("Cookie") || "";
    for (const cookie of cookieHeader.split(";")) {
        const [name, ...valueParts] = cookie.trim().split("=");
        if (name === SESSION_COOKIE) {
            return valueParts.join("=");
        }
    }
    return "";
}

async function isAuthenticated(request, env) {
    const [expiresAtText, signature, extra] = sessionCookieValue(request).split(".");
    if (!expiresAtText || !signature || extra !== undefined || !/^\d{1,12}$/.test(expiresAtText)) {
        return false;
    }

    const expiresAt = Number(expiresAtText);
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + SESSION_TTL_SECONDS) {
        return false;
    }

    const bytes = fromBase64Url(signature);
    if (!bytes || bytes.byteLength !== 32) {
        return false;
    }
    const message = `session:v1:${expiresAt}:${env.ADMIN_PASSWORD}`;
    const key = await hmacKey(env);
    return crypto.subtle.verify("HMAC", key, bytes, encoder.encode(message));
}

async function passwordMatches(password, expected) {
    const [actualHash, expectedHash] = await Promise.all([
        crypto.subtle.digest("SHA-256", encoder.encode(password)),
        crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    ]);
    const actual = new Uint8Array(actualHash);
    const target = new Uint8Array(expectedHash);
    let difference = 0;
    for (let index = 0; index < actual.length; index += 1) {
        difference |= actual[index] ^ target[index];
    }
    return difference === 0;
}

async function handleLogin(request, env) {
    if (request.method !== "POST") {
        return jsonResponse({ error: "Method not allowed" }, 405, { Allow: "POST" });
    }
    if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
        return jsonResponse({ error: "Expected JSON request" }, 415);
    }

    let body;
    try {
        body = await request.json();
    } catch {
        return jsonResponse({ error: "Invalid request" }, 400);
    }
    if (
        typeof body?.password !== "string" ||
        !(await passwordMatches(body.password, env.ADMIN_PASSWORD))
    ) {
        return jsonResponse({ error: "Incorrect password" }, 401);
    }

    const cookie = await createSessionCookie(env);
    return jsonResponse(
        { ok: true },
        200,
        {
            "Set-Cookie": `${SESSION_COOKIE}=${cookie}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; Secure; HttpOnly; SameSite=Strict`,
        },
    );
}

async function createSubscriptionLink(url, env) {
    const fileName = url.searchParams.get("file");
    if (!validFileName(fileName)) {
        return jsonResponse({ error: "Invalid file name" }, 400);
    }
    if (!signingKeyIsConfigured(env)) {
        console.error("Subscription signing key is missing or shorter than 32 bytes");
        return jsonResponse({ error: "Service is not configured" }, 503);
    }
    if (!privateFiles.has(fileName)) {
        return jsonResponse({ error: "File not found" }, 404);
    }

    const signature = await signatureFor(fileName, env);
    const subscriptionUrl = new URL(`/sub/${encodeURIComponent(fileName)}`, url.origin);
    subscriptionUrl.searchParams.set("sig", signature);
    return jsonResponse({ url: subscriptionUrl.toString() });
}

async function serveSubscription(url, env) {
    if (!signingKeyIsConfigured(env)) {
        console.error("Subscription signing key is not configured");
        return jsonResponse({ error: "Service is not configured" }, 503);
    }

    let fileName;
    try {
        fileName = decodeURIComponent(url.pathname.slice("/sub/".length));
    } catch {
        return jsonResponse({ error: "Not found" }, 404);
    }
    if (!validFileName(fileName) || !(await verifySignature(fileName, url.searchParams.get("sig") || "", env))) {
        return jsonResponse({ error: "Not found" }, 404);
    }

    const content = privateFiles.get(fileName);
    if (typeof content !== "string") {
        return jsonResponse({ error: "Subscription file not found" }, 404);
    }
    return new Response(content, {
        headers: {
            "Content-Type": fileName.toLowerCase().endsWith(".yaml")
                ? "application/yaml; charset=utf-8"
                : "text/plain; charset=utf-8",
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
        },
    });
}

function managerAssetPath(pathname) {
    return pathname === "/" ? "/index.html" : pathname;
}

async function handleRequest(request, env) {
    const url = new URL(request.url);
    if (!isWorkersDevHost(url.hostname)) {
        return jsonResponse({ error: "Not found" }, 404);
    }
    if (!configIsReady(env)) {
        console.error("Required Worker variables or ADMIN_PASSWORD are not configured");
        return jsonResponse({ error: "Service is not configured" }, 503);
    }

    if (url.pathname === "/api/login") {
        return handleLogin(request, env);
    }
    if (url.pathname === "/api/logout") {
        if (request.method !== "POST") {
            return jsonResponse({ error: "Method not allowed" }, 405, { Allow: "POST" });
        }
        return jsonResponse(
            { ok: true },
            200,
            { "Set-Cookie": `${SESSION_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict` },
        );
    }
    if (url.pathname === "/sub" || url.pathname.startsWith("/sub/")) {
        if (request.method !== "GET") {
            return jsonResponse({ error: "Not found" }, 404);
        }
        return serveSubscription(url, env);
    }
    if (url.pathname === "/login.html") {
        if (request.method !== "GET" && request.method !== "HEAD") {
            return jsonResponse({ error: "Method not allowed" }, 405);
        }
        return env.ASSETS.fetch(new Request(new URL("/login.html", url), request));
    }

    if (url.pathname === "/api/subscription-link") {
        if (request.method !== "GET") {
            return jsonResponse({ error: "Method not allowed" }, 405);
        }
        if (!(await isAuthenticated(request, env))) {
            return jsonResponse({ error: "Login required" }, 401);
        }
        return createSubscriptionLink(url, env);
    }

    const assetPath = managerAssetPath(url.pathname);
    if ((request.method === "GET" || request.method === "HEAD") && STATIC_PATHS.has(assetPath)) {
        if (!(await isAuthenticated(request, env))) {
            return env.ASSETS.fetch(new Request(new URL("/login.html", url), request));
        }
        return env.ASSETS.fetch(new Request(new URL(assetPath, url), request));
    }
    return jsonResponse({ error: "Not found" }, 404);
}

export { handleRequest };

export default {
    fetch: handleRequest,
};
