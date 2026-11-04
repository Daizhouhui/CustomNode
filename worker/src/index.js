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

function githubFileUrl(fileName, env) {
    const owner = encodeURIComponent(env.GITHUB_OWNER);
    const repository = encodeURIComponent(env.GITHUB_REPOSITORY);
    const path = encodeURIComponent(fileName);
    const ref = encodeURIComponent(env.GITHUB_REF);
    return `https://api.github.com/repos/${owner}/${repository}/contents/${path}?ref=${ref}`;
}

function githubHeaders(env, accept) {
    return {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: accept,
        "X-GitHub-Api-Version": "2022-11-28",
    };
}

async function indexedRepositoryFiles(env) {
    const response = await fetchRepositoryFile("files_info.json", env);
    if (!response.ok) {
        return { response };
    }

    try {
        const index = await response.json();
        if (!Array.isArray(index.files)) {
            throw new Error("Missing files array");
        }
        const files = new Set();
        for (const item of index.files) {
            for (const fileName of [item.node_name, item.yaml_name]) {
                if (validFileName(fileName)) {
                    files.add(fileName);
                }
            }
        }
        return { files };
    } catch (error) {
        console.error("GitHub file index is invalid", error);
        return { response: jsonResponse({ error: "Repository index is invalid" }, 502) };
    }
}

async function fetchRepositoryFile(fileName, env) {
    if (typeof env.GITHUB_TOKEN !== "string" || !env.GITHUB_TOKEN) {
        console.error("GitHub token is not configured");
        return jsonResponse({ error: "Repository access is not configured" }, 503);
    }

    let response;
    try {
        response = await fetch(githubFileUrl(fileName, env), {
            headers: githubHeaders(env, "application/vnd.github.raw+json"),
        });
    } catch (error) {
        console.error("GitHub file request failed", error);
        return jsonResponse({ error: "Unable to reach repository" }, 502);
    }
    if (!response.ok) {
        console.error("GitHub file read failed", response.status);
        if (response.status === 401) {
            return jsonResponse({ error: "GitHub rejected GITHUB_TOKEN (401). Check that the Worker Secret contains a valid token." }, 502);
        }
        if (response.status === 403) {
            return jsonResponse({ error: "GitHub denied repository access (403). Check the token's repository selection, Contents read permission, and organization SSO authorization." }, 502);
        }
        if (response.status === 404) {
            return jsonResponse({ error: "GitHub could not find this file or the token cannot access the private repository (404)." }, 404);
        }
        return jsonResponse({ error: `GitHub repository request failed (HTTP ${response.status}).` }, 502);
    }
    return new Response(response.body, {
        headers: {
            "Content-Type": fileName.toLowerCase().endsWith(".html")
                ? "text/html; charset=utf-8"
                : fileName.toLowerCase().endsWith(".yaml")
                    ? "application/yaml; charset=utf-8"
                    : "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        },
    });
}

async function deleteGitHubFile(fileName, env) {
    const url = githubFileUrl(fileName, env);
    const headers = githubHeaders(env, "application/vnd.github+json");
    try {
        const fileResponse = await fetch(url, { headers });
        if (fileResponse.status === 404) {
            return { file: fileName, success: true };
        }
        if (!fileResponse.ok) {
            console.error("GitHub file lookup for deletion failed", fileResponse.status);
            return { file: fileName, success: false, error: "Unable to inspect repository file" };
        }

        const file = await fileResponse.json();
        if (file.path !== fileName || file.type !== "file" || typeof file.sha !== "string") {
            return { file: fileName, success: false, error: "Repository path is not a regular file" };
        }

        const deleteResponse = await fetch(url, {
            method: "DELETE",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({
                message: `Delete ${fileName} via CustomNode Manager`,
                sha: file.sha,
                branch: env.GITHUB_REF,
            }),
        });
        if (!deleteResponse.ok) {
            let error = "GitHub rejected the deletion";
            try {
                const body = await deleteResponse.json();
                if (typeof body.message === "string") {
                    error = body.message;
                }
            } catch {
                // Keep the generic error when GitHub does not return JSON.
            }
            console.error("GitHub file deletion failed", deleteResponse.status);
            return { file: fileName, success: false, error };
        }
        return { file: fileName, success: true };
    } catch (error) {
        console.error("GitHub file deletion request failed", error);
        return { file: fileName, success: false, error: "Unable to reach GitHub" };
    }
}

async function handleDeleteFiles(request, env) {
    if (request.method !== "POST") {
        return jsonResponse({ error: "Method not allowed" }, 405, { Allow: "POST" });
    }
    if (request.headers.get("Origin") !== `https://${env.APP_HOST}`) {
        return jsonResponse({ error: "Invalid request origin" }, 403);
    }
    if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
        return jsonResponse({ error: "Expected JSON request" }, 415);
    }
    if (typeof env.GITHUB_TOKEN !== "string" || !env.GITHUB_TOKEN) {
        console.error("GitHub token is not configured");
        return jsonResponse({ error: "Repository access is not configured" }, 503);
    }

    let body;
    try {
        body = await request.json();
    } catch {
        return jsonResponse({ error: "Invalid request" }, 400);
    }
    if (
        !Array.isArray(body?.files) ||
        body.files.length === 0 ||
        body.files.length > 40 ||
        body.files.some((fileName) => !validFileName(fileName)) ||
        new Set(body.files).size !== body.files.length
    ) {
        return jsonResponse({ error: "Invalid file list" }, 400);
    }

    const indexedFiles = await indexedRepositoryFiles(env);
    if (!indexedFiles.files) {
        return indexedFiles.response;
    }
    if (body.files.some((fileName) => !indexedFiles.files.has(fileName))) {
        return jsonResponse({ error: "A requested file is not listed as a node file" }, 400);
    }

    const results = [];
    for (const fileName of body.files) {
        results.push(await deleteGitHubFile(fileName, env));
    }
    return jsonResponse({ results });
}

function isConfiguredHost(hostname, env) {
    return typeof env.APP_HOST === "string" && hostname.toLowerCase() === env.APP_HOST.toLowerCase();
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
    const indexedFiles = await indexedRepositoryFiles(env);
    if (!indexedFiles.files) {
        return indexedFiles.response;
    }
    if (!indexedFiles.files.has(fileName)) {
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

    const response = await fetchRepositoryFile(fileName, env);
    if (response.ok) {
        response.headers.set("Cache-Control", "private, no-store");
    }
    return response;
}

function managerAssetPath(pathname) {
    return pathname === "/" ? "/index.html" : pathname;
}

async function handleRequest(request, env) {
    const url = new URL(request.url);
    if (!isConfiguredHost(url.hostname, env)) {
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
    if (url.pathname === "/login" || url.pathname === "/login/" || url.pathname === "/login.html") {
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
    if (url.pathname === "/api/files/delete") {
        if (!(await isAuthenticated(request, env))) {
            return jsonResponse({ error: "Login required" }, 401);
        }
        return handleDeleteFiles(request, env);
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
        if (request.method !== "GET" && request.method !== "HEAD") {
            return jsonResponse({ error: "Method not allowed" }, 405);
        }
        if (!(await isAuthenticated(request, env))) {
            return env.ASSETS.fetch(new Request(new URL("/login.html", url), request));
        }
        return fetchRepositoryFile("index.html", env);
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
