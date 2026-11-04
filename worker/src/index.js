const encoder = new TextEncoder();
const FILE_NAME_PATTERN = /^[^/\\\u0000-\u001f\u007f]{1,240}$/u;
const STATIC_PATHS = new Set(["/", "/index.html", "/update-index.html", "/style/ico.png"]);

function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
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
        env.GITHUB_OWNER &&
            env.GITHUB_REPOSITORY &&
            env.GITHUB_REF &&
            env.APP_HOST,
    );
}

async function signatureFor(fileName, env) {
    const signingKey = await crypto.subtle.importKey(
        "raw",
        encoder.encode(env.SUBSCRIPTION_SIGNING_KEY),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
    );
    const message = `${env.GITHUB_OWNER}/${env.GITHUB_REPOSITORY}/${env.GITHUB_REF}/${fileName}`;
    const signature = await crypto.subtle.sign("HMAC", signingKey, encoder.encode(message));
    const binary = String.fromCharCode(...new Uint8Array(signature));
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function verifySignature(fileName, signature, env) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(signature)) {
        return false;
    }

    const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(env.SUBSCRIPTION_SIGNING_KEY),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"],
    );
    const base64 = signature.replace(/-/g, "+").replace(/_/g, "/") + "=";
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const message = `${env.GITHUB_OWNER}/${env.GITHUB_REPOSITORY}/${env.GITHUB_REF}/${fileName}`;
    return crypto.subtle.verify("HMAC", key, bytes, encoder.encode(message));
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

    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== env.APP_HOST.toLowerCase()) {
        console.error("Subscription links must use the configured HTTPS host");
        return jsonResponse({ error: "Service is not configured" }, 503);
    }

    const signature = await signatureFor(fileName, env);
    const subscriptionUrl = new URL(`/sub/${encodeURIComponent(fileName)}`, url.origin);
    subscriptionUrl.searchParams.set("sig", signature);
    return jsonResponse({ url: subscriptionUrl.toString() });
}

async function serveSubscription(url, env) {
    if (!signingKeyIsConfigured(env) || !env.GITHUB_READ_TOKEN) {
        console.error("Subscription service secrets are not configured");
        return jsonResponse({ error: "Service is not configured" }, 503);
    }

    let fileName;
    try {
        fileName = decodeURIComponent(url.pathname.slice("/sub/".length));
    } catch {
        return jsonResponse({ error: "Not found" }, 404);
    }
    if (!validFileName(fileName)) {
        return jsonResponse({ error: "Not found" }, 404);
    }

    const signature = url.searchParams.get("sig") || "";
    if (!(await verifySignature(fileName, signature, env))) {
        return jsonResponse({ error: "Not found" }, 404);
    }

    const githubUrl = new URL(
        `https://api.github.com/repos/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPOSITORY)}/contents/${encodeURIComponent(fileName)}`,
    );
    githubUrl.searchParams.set("ref", env.GITHUB_REF);

    let githubResponse;
    try {
        githubResponse = await fetch(githubUrl, {
            headers: {
                Accept: "application/vnd.github.raw+json",
                Authorization: `Bearer ${env.GITHUB_READ_TOKEN}`,
                "X-GitHub-Api-Version": "2022-11-28",
            },
        });
    } catch (error) {
        console.error("GitHub content request failed", error);
        return jsonResponse({ error: "Subscription source is unavailable" }, 502);
    }

    if (githubResponse.status === 404) {
        return jsonResponse({ error: "Subscription file not found" }, 404);
    }
    if (!githubResponse.ok) {
        console.error("GitHub content request returned status", githubResponse.status);
        return jsonResponse({ error: "Subscription source is unavailable" }, 502);
    }

    return new Response(githubResponse.body, {
        headers: {
            "Content-Type": fileName.toLowerCase().endsWith(".yaml")
                ? "application/yaml; charset=utf-8"
                : "text/plain; charset=utf-8",
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
        },
    });
}

async function handleRequest(request, env) {
    const url = new URL(request.url);
    const hostname = url.hostname.toLowerCase();

    if (!configIsReady(env)) {
        console.error("Required Worker variables are not configured");
        return jsonResponse({ error: "Service is not configured" }, 503);
    }

    if (hostname === env.APP_HOST.toLowerCase()) {
        if (url.pathname === "/api/subscription-link") {
            if (request.method !== "GET") {
                return jsonResponse({ error: "Method not allowed" }, 405);
            }
            return createSubscriptionLink(url, env);
        }

        if (url.pathname.startsWith("/sub/")) {
            if (request.method !== "GET") {
                return jsonResponse({ error: "Not found" }, 404);
            }
            return serveSubscription(url, env);
        }

        if (
            (request.method === "GET" || request.method === "HEAD") &&
            STATIC_PATHS.has(url.pathname) &&
            env.ASSETS
        ) {
            return env.ASSETS.fetch(request);
        }
        return jsonResponse({ error: "Not found" }, 404);
    }

    return jsonResponse({ error: "Not found" }, 404);
}

export { handleRequest };

export default {
    fetch: handleRequest,
};
