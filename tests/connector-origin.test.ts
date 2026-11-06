import assert from "node:assert/strict";
import test from "node:test";
import {
  assertConnectorEnvironment,
  clerkIssuer,
  connectorAudienceForRequest,
  connectorListenPortMismatch,
  connectorPublicSurface,
  connectorResourceUrl,
  parseClerkOAuthIssuer,
  parseConnectorPublicOrigin,
  protectedResourceMetadata,
  resolveConnectorOrigin,
} from "@/services/connector/config";

function withOrigin<T>(value: string | undefined, run: () => T): T {
  const previous = process.env.CONNECTOR_PUBLIC_ORIGIN;
  if (value === undefined) delete process.env.CONNECTOR_PUBLIC_ORIGIN;
  else process.env.CONNECTOR_PUBLIC_ORIGIN = value;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.CONNECTOR_PUBLIC_ORIGIN;
    else process.env.CONNECTOR_PUBLIC_ORIGIN = previous;
  }
}

test("https production and staging origins become MCP URLs", () => {
  assert.deepEqual(parseConnectorPublicOrigin("https://app.example.com"), {
    ok: true,
    origin: "https://app.example.com",
    https: true,
    loopback: false,
  });
  assert.deepEqual(parseConnectorPublicOrigin("https://staging.meritdesk.example:8443/"), {
    ok: true,
    origin: "https://staging.meritdesk.example:8443",
    https: true,
    loopback: false,
  });
  assert.deepEqual(withOrigin("https://app.example.com", () => connectorPublicSurface()), {
    origin: "https://app.example.com",
    mcpUrl: "https://app.example.com/api/mcp",
    metadataUrl: "https://app.example.com/.well-known/oauth-protected-resource",
    billingUrl: "https://app.example.com/billing",
    https: true,
    loopback: false,
    hostedClientsNeedHttps: true,
  });
});

test("loopback HTTP is accepted on 3100 and 3101 and not rewritten to 3000", () => {
  for (const origin of ["http://127.0.0.1:3100", "http://127.0.0.1:3101", "http://localhost:3101"]) {
    const parsed = parseConnectorPublicOrigin(origin);
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.https, false);
      assert.equal(parsed.loopback, true);
      assert.equal(connectorResourceUrl(parsed.origin), `${parsed.origin}/api/mcp`);
    }
  }
});

test("explicit port 3000 is kept only when configured, never taken from Host", () => {
  const configured = parseConnectorPublicOrigin("http://127.0.0.1:3000");
  assert.equal(configured.ok, true);
  if (configured.ok) assert.equal(configured.origin, "http://127.0.0.1:3000");

  withOrigin("http://127.0.0.1:3101", () => {
    const headers = new Headers({
      host: "127.0.0.1:3000",
      "x-forwarded-host": "127.0.0.1:3000",
      "x-forwarded-proto": "http",
    });
    const { origin, fromRequest } = resolveConnectorOrigin(headers, "http://127.0.0.1:3000/setup", false);
    assert.equal(origin, "http://127.0.0.1:3101");
    assert.equal(fromRequest, false);
    assert.equal(
      connectorAudienceForRequest(new Request("http://127.0.0.1:3000/api/mcp", { headers }), false),
      "http://127.0.0.1:3101/api/mcp"
    );
  });
});

test("missing CONNECTOR_PUBLIC_ORIGIN does not fall back to localhost:3000", () => {
  withOrigin(undefined, () => {
    const headers = new Headers({ host: "127.0.0.1:3000" });
    const resolved = resolveConnectorOrigin(headers, "http://127.0.0.1:3000/setup", false);
    assert.equal(resolved.origin, null);
    assert.match(resolved.error ?? "", /CONNECTOR_PUBLIC_ORIGIN is not set/);
    assert.equal(connectorAudienceForRequest(new Request("http://127.0.0.1:3000/api/mcp"), true), null);
    const surface = connectorPublicSurface();
    assert.equal("error" in surface, true);
  });
});

test("invalid origins are rejected with an actionable error", () => {
  assert.equal(parseConnectorPublicOrigin("https://app.example.com/api/mcp").ok, false);
  assert.equal(parseConnectorPublicOrigin("ftp://app.example.com").ok, false);
  assert.equal(parseConnectorPublicOrigin("https://user:pass@app.example.com").ok, false);
  assert.equal(parseConnectorPublicOrigin("http://app.example.com").ok, false);
  const httpPublic = parseConnectorPublicOrigin("http://staging.example.com");
  assert.equal(httpPublic.ok, false);
  if (!httpPublic.ok) assert.match(httpPublic.error, /https/);
});

test("production OAuth audience is the configured origin even when the request Host is an attacker", () => {
  withOrigin("https://mcp.meritdesk.example", () => {
    const request = new Request("https://attacker.example/api/mcp", { headers: { host: "attacker.example" } });
    assert.equal(connectorAudienceForRequest(request, true), "https://mcp.meritdesk.example/api/mcp");
  });
});

test("CLERK_OAUTH_ISSUER must be an https origin when set", () => {
  assert.deepEqual(parseClerkOAuthIssuer(""), { ok: true, issuer: null });
  assert.deepEqual(parseClerkOAuthIssuer("https://clerk.example.com/"), { ok: true, issuer: "https://clerk.example.com" });
  assert.equal(parseClerkOAuthIssuer("http://clerk.example.com").ok, false);
  assert.equal(parseClerkOAuthIssuer("https://clerk.example.com/v1").ok, false);
});

test("startup assertion throws on invalid origin and on missing origin in production", () => {
  withOrigin("https://app.example.com/api/mcp", () => {
    assert.throws(() => assertConnectorEnvironment(false), /origin only/);
  });
  withOrigin(undefined, () => {
    assert.throws(() => assertConnectorEnvironment(true), /not set/);
  });
  withOrigin("https://app.example.com", () => {
    assert.doesNotThrow(() => assertConnectorEnvironment(true));
  });
});

test("3100 and 3101 each generate their own MCP URL from CONNECTOR_PUBLIC_ORIGIN", () => {
  withOrigin("http://127.0.0.1:3100", () => {
    const surface = connectorPublicSurface();
    assert.equal("error" in surface, false);
    if (!("error" in surface)) {
      assert.equal(surface.mcpUrl, "http://127.0.0.1:3100/api/mcp");
      assert.equal(surface.metadataUrl, "http://127.0.0.1:3100/.well-known/oauth-protected-resource");
      assert.equal(surface.https, false);
      assert.equal(connectorListenPortMismatch(surface, "3100"), null);
    }
  });
  withOrigin("http://127.0.0.1:3101", () => {
    const surface = connectorPublicSurface();
    assert.equal("error" in surface, false);
    if (!("error" in surface)) {
      assert.equal(surface.mcpUrl, "http://127.0.0.1:3101/api/mcp");
      assert.equal(connectorListenPortMismatch(surface, "3101"), null);
    }
  });
});

test("listen PORT 3101 does not rewrite a configured :3000 origin", () => {
  withOrigin("http://127.0.0.1:3000", () => {
    const previousPort = process.env.PORT;
    process.env.PORT = "3101";
    try {
      const surface = connectorPublicSurface();
      assert.equal("error" in surface, false);
      if (!("error" in surface)) {
        assert.equal(surface.mcpUrl, "http://127.0.0.1:3000/api/mcp");
        assert.match(connectorListenPortMismatch(surface, "3101") ?? "", /PORT is 3101/);
        assert.equal(
          connectorAudienceForRequest(new Request("http://127.0.0.1:3101/api/mcp"), false),
          "http://127.0.0.1:3000/api/mcp"
        );
      }
    } finally {
      if (previousPort === undefined) delete process.env.PORT;
      else process.env.PORT = previousPort;
    }
  });
});

test("OAuth issuer stays on Clerk while resource URLs stay on CONNECTOR_PUBLIC_ORIGIN", () => {
  const previousIssuer = process.env.CLERK_OAUTH_ISSUER;
  process.env.CLERK_OAUTH_ISSUER = "https://clerk.example.com";
  try {
    withOrigin("https://app.example.com", () => {
      assert.equal(clerkIssuer(), "https://clerk.example.com");
      const surface = connectorPublicSurface();
      assert.equal("error" in surface, false);
      if (!("error" in surface)) {
        const metadata = protectedResourceMetadata(surface.origin, clerkIssuer()!);
        assert.equal(metadata.resource, "https://app.example.com/api/mcp");
        assert.deepEqual(metadata.authorization_servers, ["https://clerk.example.com"]);
        assert.notEqual(metadata.resource, clerkIssuer());
      }
    });
  } finally {
    if (previousIssuer === undefined) delete process.env.CLERK_OAUTH_ISSUER;
    else process.env.CLERK_OAUTH_ISSUER = previousIssuer;
  }
});
