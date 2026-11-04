import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.js";

const env = {
    ADMIN_PASSWORD: "test-admin-password-with-enough-length",
    GITHUB_TOKEN: "test-github-token",
    GITHUB_OWNER: "example",
    GITHUB_REPOSITORY: "nodes",
    GITHUB_REF: "main",
    APP_HOST: "manager.example.com",
    SUBSCRIPTION_SIGNING_KEY: "test-signing-key-with-sufficient-test-only-entropy",
};
const host = env.APP_HOST;
const firstFileName = "test-node";

function request(path, { method = "GET", headers = {}, body } = {}) {
    return new Request(`https://${host}${path}`, { method, headers, body });
}

function githubIndex(files = [firstFileName]) {
    const allFiles = files.map((nodeName) => ({ node_name: nodeName }));
    return new Response(`<script>const allFiles = ${JSON.stringify(allFiles)};</script>`, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
    });
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

async function withMockGitHub(handler, callback) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = handler;
    try {
        return await callback();
    } finally {
        globalThis.fetch = originalFetch;
    }
}

test("rejects hosts other than the configured custom domain", async () => {
    const response = await worker.fetch(
        new Request("https://other.example.com/", { method: "GET" }),
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

    const loginRoute = await worker.fetch(request("/login"), testEnv);
    assert.equal(loginRoute.status, 200);
    assert.equal(servedPath, "/login.html");

    const trailingSlashLoginRoute = await worker.fetch(request("/login/"), testEnv);
    assert.equal(trailingSlashLoginRoute.status, 200);
    assert.equal(servedPath, "/login.html");

    const managerPage = await worker.fetch(request("/"), testEnv);
    assert.equal(managerPage.status, 200);
    assert.equal(servedPath, "/login.html");

    const cookie = await login();
    await withMockGitHub(async (input, options) => {
        const githubRequest = new URL(input);
        assert.match(githubRequest.pathname, /\/repos\/example\/nodes\/contents\/index\.html/);
        assert.equal(new Headers(options.headers).get("User-Agent"), "CustomNode-Worker");
        assert.equal(new Headers(options.headers).get("Authorization"), `Bearer ${env.GITHUB_TOKEN}`);
        return new Response("<html>latest index</html>");
    }, async () => {
        const authenticatedPage = await worker.fetch(
            request("/", { headers: { Cookie: cookie } }),
            testEnv,
        );
        assert.equal(authenticatedPage.status, 200);
        assert.match(await authenticatedPage.text(), /latest index/);
    });

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

test("issues signed links for valid node filenames", async () => {
    const cookie = await login();
    await withMockGitHub(async () => githubIndex(), async () => {
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

test("does not issue signed links for files absent from the current repository index", async () => {
    const cookie = await login();
    const response = await withMockGitHub(async () => githubIndex(["another-node"]), () =>
        worker.fetch(
            request(`/api/subscription-link?file=${encodeURIComponent(firstFileName)}`, {
                headers: { Cookie: cookie },
            }),
            env,
        ),
    );
    assert.equal(response.status, 404);
});

test("reports safe GitHub authorization diagnostics without exposing response bodies", async () => {
    const cookie = await login();
    for (const [upstreamResponse, message] of [
        [new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 }), /GITHUB_TOKEN.*401/],
        [
            new Response(JSON.stringify({ message: "Resource not accessible by personal access token" }), { status: 403 }),
            /cannot access the requested resource/,
        ],
        [
            new Response(JSON.stringify({ message: "API rate limit exceeded" }), { status: 403 }),
            /rate limit reached/,
        ],
        [
            new Response(JSON.stringify({ message: "Resource denied" }), {
                status: 403,
                headers: { "X-GitHub-SSO": "required; url=https://github.com/orgs/example/sso" },
            }),
            /requires organization SSO authorization/,
        ],
    ]) {
        const response = await withMockGitHub(async () =>
            upstreamResponse,
        () =>
            worker.fetch(
                request("/", { headers: { Cookie: cookie } }),
                {
                    ...env,
                    ASSETS: { fetch: async () => new Response("login") },
                },
            ),
        );
        assert.equal(response.status, 502);
        const body = await response.json();
        assert.match(body.error, message);
        assert.equal(JSON.stringify(body).includes("Bad credentials"), false);
    }
});

test("returns the current GitHub file content only for a valid signed URL", async () => {
    const cookie = await login();
    const linkResponse = await withMockGitHub(async () => githubIndex(), () =>
        worker.fetch(
            request(`/api/subscription-link?file=${encodeURIComponent(firstFileName)}`, {
                headers: { Cookie: cookie },
            }),
            env,
        ),
    );
    const subscriptionUrl = new URL((await linkResponse.json()).url);
    await withMockGitHub(async (input, options) => {
        const githubRequest = new URL(input);
        assert.match(githubRequest.pathname, /contents\/test-node$/);
        assert.equal(githubRequest.searchParams.get("ref"), "main");
        assert.equal(new Headers(options.headers).get("User-Agent"), "CustomNode-Worker");
        assert.equal(new Headers(options.headers).get("Authorization"), `Bearer ${env.GITHUB_TOKEN}`);
        return new Response("current repository node content");
    }, async () => {
        const response = await worker.fetch(new Request(subscriptionUrl), env);
        assert.equal(response.status, 200);
        assert.equal(await response.text(), "current repository node content");
        assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    });

    subscriptionUrl.searchParams.set("sig", "invalid");
    const denied = await worker.fetch(new Request(subscriptionUrl), env);
    assert.equal(denied.status, 404);
});

test("deletes repository files through the Worker secret only for an authenticated same-origin request", async () => {
    let deleteCalled = false;
    const cookie = await login();
    const headers = {
        Cookie: cookie,
        Origin: `https://${host}`,
        "Content-Type": "application/json",
    };

    await withMockGitHub(async (input, options) => {
        const githubRequest = new URL(input);
        assert.equal(new Headers(options.headers).get("Authorization"), `Bearer ${env.GITHUB_TOKEN}`);
        if (githubRequest.pathname.endsWith("/index.html")) {
            assert.equal(options.method, undefined);
            return githubIndex();
        }
        if (options.method === "DELETE") {
            deleteCalled = true;
            assert.deepEqual(JSON.parse(options.body), {
                message: `Delete ${firstFileName} via CustomNode Manager`,
                sha: "file-sha",
                branch: "main",
            });
            return Response.json({ commit: { sha: "commit-sha" } });
        }
        return Response.json({ path: firstFileName, type: "file", sha: "file-sha" });
    }, async () => {
        const response = await worker.fetch(
            request("/api/files/delete", {
                method: "POST",
                headers,
                body: JSON.stringify({ files: [firstFileName] }),
            }),
            env,
        );
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), {
            results: [{ file: firstFileName, success: true }],
        });
    });
    assert.equal(deleteCalled, true);

    const denied = await worker.fetch(
        request("/api/files/delete", {
            method: "POST",
            headers: { ...headers, Cookie: "" },
            body: JSON.stringify({ files: [firstFileName] }),
        }),
        env,
    );
    assert.equal(denied.status, 401);
});

test("deletes files listed on the current index page even when metadata JSON is stale", async () => {
    const cookie = await login();
    const files = ["t1", "t1.yaml"];
    const deletedFiles = [];

    const response = await withMockGitHub(async (input, options) => {
        const githubRequest = new URL(input);
        if (githubRequest.pathname.endsWith("/index.html")) {
            return new Response(
                `<script>const allFiles = ${JSON.stringify([{ node_name: files[0], yaml_name: files[1] }])};</script>`,
                { headers: { "Content-Type": "text/html; charset=utf-8" } },
            );
        }
        if (options.method === "DELETE") {
            deletedFiles.push(decodeURIComponent(githubRequest.pathname.split("/").pop()));
            return Response.json({ commit: { sha: `deleted-${deletedFiles.length}` } });
        }
        return Response.json({
            path: decodeURIComponent(githubRequest.pathname.split("/").pop()),
            type: "file",
            sha: "file-sha",
        });
    }, () =>
        worker.fetch(
            request("/api/files/delete", {
                method: "POST",
                headers: {
                    Cookie: cookie,
                    Origin: `https://${host}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ files }),
            }),
            env,
        ),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(deletedFiles, files);
    assert.deepEqual((await response.json()).results, files.map((file) => ({ file, success: true })));
});

test("rejects deletion requests with invalid origin or unsafe paths", async () => {
    const cookie = await login();
    const commonHeaders = { Cookie: cookie, "Content-Type": "application/json" };

    const badOrigin = await worker.fetch(
        request("/api/files/delete", {
            method: "POST",
            headers: { ...commonHeaders, Origin: "https://attacker.example" },
            body: JSON.stringify({ files: [firstFileName] }),
        }),
        env,
    );
    assert.equal(badOrigin.status, 403);

    const unsafePath = await worker.fetch(
        request("/api/files/delete", {
            method: "POST",
            headers: { ...commonHeaders, Origin: `https://${host}` },
            body: JSON.stringify({ files: ["../README.md"] }),
        }),
        env,
    );
    assert.equal(unsafePath.status, 400);
});

test("does not delete repository files absent from the current node index", async () => {
    const cookie = await login();
    const response = await withMockGitHub(async () => githubIndex(["another-node"]), () =>
        worker.fetch(
            request("/api/files/delete", {
                method: "POST",
                headers: {
                    Cookie: cookie,
                    Origin: `https://${host}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ files: [firstFileName] }),
            }),
            env,
        ),
    );
    assert.equal(response.status, 400);
});

test("logout clears the session cookie", async () => {
    const response = await worker.fetch(
        request("/api/logout", { method: "POST" }),
        env,
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("Set-Cookie"), /Max-Age=0/);
});
