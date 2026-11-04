import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.js";

const env = {
    GITHUB_OWNER: "example",
    GITHUB_REPOSITORY: "nodes",
    GITHUB_REF: "old",
    APP_HOST: "manage.example.com",
    SUBSCRIPTION_HOST: "sub.example.com",
    SUBSCRIPTION_ORIGIN: "https://sub.example.com",
    SUBSCRIPTION_SIGNING_KEY: "test-signing-key-with-sufficient-test-only-entropy",
    GITHUB_READ_TOKEN: "test-token",
};

function request(host, path, method = "GET") {
    return new Request(`https://${host}${path}`, { method });
}

test("rejects hosts that are not configured", async () => {
    const response = await worker.fetch(request("other.example.com", "/"), env);
    assert.equal(response.status, 404);
});

test("serves only the allowlisted manager assets", async () => {
    const response = await worker.fetch(request(env.APP_HOST, "/style/ico.png"), {
        ...env,
        ASSETS: { fetch: async () => new Response("icon") },
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "icon");

    const blocked = await worker.fetch(request(env.APP_HOST, "/files_info.json"), {
        ...env,
        ASSETS: { fetch: async () => new Response("should not be served") },
    });
    assert.equal(blocked.status, 404);
});

test("returns a signed subscription URL without exposing the signing key", async () => {
    const response = await worker.fetch(
        request(env.APP_HOST, "/api/subscription-link?file=nodes.yaml"),
        env,
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    const url = new URL(body.url);
    assert.equal(url.hostname, env.SUBSCRIPTION_HOST);
    assert.equal(url.pathname, "/sub/nodes.yaml");
    assert.match(url.searchParams.get("sig"), /^[A-Za-z0-9_-]{43}$/);
    assert.equal(body.url.includes(env.SUBSCRIPTION_SIGNING_KEY), false);
});

test("rejects invalid filenames when issuing subscription URLs", async () => {
    const response = await worker.fetch(
        request(env.APP_HOST, "/api/subscription-link?file=..%2FREADME.md"),
        env,
    );
    assert.equal(response.status, 400);
});

test("refuses to issue links when the signing key is too short", async () => {
    const response = await worker.fetch(
        request(env.APP_HOST, "/api/subscription-link?file=nodes.yaml"),
        { ...env, SUBSCRIPTION_SIGNING_KEY: "too-short" },
    );
    assert.equal(response.status, 503);
});

test("rejects invalid signatures without requesting GitHub", async () => {
    const originalFetch = globalThis.fetch;
    let githubRequested = false;
    globalThis.fetch = async () => {
        githubRequested = true;
        return new Response("unexpected");
    };
    try {
        const response = await worker.fetch(
            request(env.SUBSCRIPTION_HOST, "/sub/nodes.yaml?sig=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
            env,
        );
        assert.equal(response.status, 404);
        assert.equal(githubRequested, false);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("returns private GitHub content only for a valid signed URL", async () => {
    const linkResponse = await worker.fetch(
        request(env.APP_HOST, "/api/subscription-link?file=nodes.yaml"),
        env,
    );
    const subscriptionUrl = new URL((await linkResponse.json()).url);
    const originalFetch = globalThis.fetch;
    let requestedUrl;
    globalThis.fetch = async (input, options) => {
        requestedUrl = new URL(input);
        assert.equal(options.headers.Authorization, `Bearer ${env.GITHUB_READ_TOKEN}`);
        assert.equal(options.headers.Accept, "application/vnd.github.raw+json");
        return new Response("proxy: node");
    };
    try {
        const response = await worker.fetch(new Request(subscriptionUrl), env);
        assert.equal(response.status, 200);
        assert.equal(await response.text(), "proxy: node");
        assert.equal(requestedUrl.hostname, "api.github.com");
        assert.equal(requestedUrl.searchParams.get("ref"), env.GITHUB_REF);
        assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    } finally {
        globalThis.fetch = originalFetch;
    }
});
