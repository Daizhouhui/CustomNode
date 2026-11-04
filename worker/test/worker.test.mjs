import assert from "node:assert/strict";
import test from "node:test";
import privateFiles from "../generated/private-data.js";
import worker from "../src/index.js";

const env = {
    ADMIN_PASSWORD: "test-admin-password-with-enough-length",
    GITHUB_OWNER: "example",
    GITHUB_REPOSITORY: "nodes",
    GITHUB_REF: "main",
    SUBSCRIPTION_SIGNING_KEY: "test-signing-key-with-sufficient-test-only-entropy",
};
const host = "customnode-test.account.workers.dev";
const firstFileName = privateFiles.keys().next().value;

function request(path, { method = "GET", headers = {}, body } = {}) {
    return new Request(`https://${host}${path}`, { method, headers, body });
}

async function login() {
    const response = await worker.fetch(
        request("/api/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password: env.ADMIN_PASSWORD }),
        }),
        env,
    );
    assert.equal(response.status, 200);
    return response.headers.get("Set-Cookie").split(";")[0];
}

test("rejects hosts that are not workers.dev", async () => {
    const response = await worker.fetch(
        new Request("https://manager.example.com/", { method: "GET" }),
        env,
    );
    assert.equal(response.status, 404);
});

test("login page is public while manager assets are protected", async () => {
    let servedPath;
    const testEnv = {
        ...env,
        ASSETS: {
            fetch: async (assetRequest) => {
                servedPath = new URL(assetRequest.url).pathname;
                return new Response(`asset:${servedPath}`);
            },
        },
    };

    const loginPage = await worker.fetch(request("/login.html"), testEnv);
    assert.equal(loginPage.status, 200);
    assert.equal(servedPath, "/login.html");

    const managerPage = await worker.fetch(request("/"), testEnv);
    assert.equal(managerPage.status, 200);
    assert.equal(servedPath, "/login.html");

    const cookie = await login();
    const authenticatedPage = await worker.fetch(
        request("/", { headers: { Cookie: cookie } }),
        testEnv,
    );
    assert.equal(authenticatedPage.status, 200);
    assert.equal(servedPath, "/index.html");

    const privateModule = await worker.fetch(request("/worker/generated/private-data.js"), testEnv);
    assert.equal(privateModule.status, 404);
});

test("login rejects wrong passwords and issues a secure short-lived session", async () => {
    const denied = await worker.fetch(
        request("/api/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password: "incorrect-password" }),
        }),
        env,
    );
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get("Set-Cookie"), null);

    const cookie = await login();
    assert.match(cookie, /^customnode_session=\d+\.[A-Za-z0-9_-]{43}$/);
    const cookieHeader = (await worker.fetch(
        request("/api/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password: env.ADMIN_PASSWORD }),
        }),
        env,
    )).headers.get("Set-Cookie");
    assert.match(cookieHeader, /; Secure; HttpOnly; SameSite=Strict$/);
    assert.match(cookieHeader, /; Max-Age=43200;/);
});

test("subscription link endpoint requires a valid session", async () => {
    const unauthenticated = await worker.fetch(
        request(`/api/subscription-link?file=${encodeURIComponent(firstFileName)}`),
        env,
    );
    assert.equal(unauthenticated.status, 401);

    const cookie = await login();
    const tampered = cookie.replace(/\.[^.]+$/, ".AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    const denied = await worker.fetch(
        request(`/api/subscription-link?file=${encodeURIComponent(firstFileName)}`, {
            headers: { Cookie: tampered },
        }),
        env,
    );
    assert.equal(denied.status, 401);
});

test("issues signed links only for bundled node files", async () => {
    const cookie = await login();
    const response = await worker.fetch(
        request(`/api/subscription-link?file=${encodeURIComponent(firstFileName)}`, {
            headers: { Cookie: cookie },
        }),
        env,
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    const url = new URL(body.url);
    assert.equal(url.hostname, host);
    assert.equal(url.pathname, `/sub/${encodeURIComponent(firstFileName)}`);
    assert.match(url.searchParams.get("sig"), /^[A-Za-z0-9_-]{43}$/);
    assert.equal(body.url.includes(env.SUBSCRIPTION_SIGNING_KEY), false);
});

test("rejects invalid filenames when issuing subscription URLs", async () => {
    const cookie = await login();
    const response = await worker.fetch(
        request("/api/subscription-link?file=..%2FREADME.md", {
            headers: { Cookie: cookie },
        }),
        env,
    );
    assert.equal(response.status, 400);
});

test("returns bundled private file content only for a valid signed URL", async () => {
    const cookie = await login();
    const linkResponse = await worker.fetch(
        request(`/api/subscription-link?file=${encodeURIComponent(firstFileName)}`, {
            headers: { Cookie: cookie },
        }),
        env,
    );
    const subscriptionUrl = new URL((await linkResponse.json()).url);
    const response = await worker.fetch(new Request(subscriptionUrl), env);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), privateFiles.get(firstFileName));
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");

    subscriptionUrl.searchParams.set("sig", "invalid");
    const denied = await worker.fetch(new Request(subscriptionUrl), env);
    assert.equal(denied.status, 404);
});

test("logout clears the session cookie", async () => {
    const response = await worker.fetch(
        request("/api/logout", { method: "POST" }),
        env,
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("Set-Cookie"), /Max-Age=0/);
});
