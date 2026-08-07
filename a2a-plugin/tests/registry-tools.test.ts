import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RegistryClient } from "../src/registry-client.js";
import {
  createHarness,
  invokeGatewayMethod,
  makeConfig,
  registerPlugin,
} from "./helpers.js";

const CENTER = "http://registry.test:8000";

function registryConfig(overrides: Record<string, unknown> = {}) {
  return makeConfig({
    agentCard: {
      name: "Test Agent",
      description: "registry tool test",
      skills: [{ id: "chat", name: "chat" }],
    },
    tunnel: {
      enabled: true,
      relayUrl: "ws://relay.test:9000",
      deviceId: "HW-PC1",
    },
    registry: {
      enabled: true,
      baseUrl: CENTER,
      dataset: "openclaw_devices",
      serviceId: "HW-PC1",
      registerOnStart: false,
      discoverIntervalMs: 60_000,
      ...overrides,
    },
    peers: [],
  });
}

function mockRegistryFetch(handlers: {
  onRegister?: (body: Record<string, unknown>) => void;
  listBody?: unknown;
  listStatus?: number;
  registerStatus?: number;
  datasetStatus?: number;
}) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method || "GET").toUpperCase();

    if (url === `${CENTER}/api/datasets` && method === "POST") {
      return new Response(JSON.stringify({ ok: true }), {
        status: handlers.datasetStatus ?? 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (url === `${CENTER}/api/datasets/openclaw_devices/services/a2a` && method === "POST") {
      const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      handlers.onRegister?.(body);
      return new Response(JSON.stringify({ registered: true, service_id: body.service_id }), {
        status: handlers.registerStatus ?? 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (url.startsWith(`${CENTER}/api/datasets/openclaw_devices/services`) && method === "GET") {
      return new Response(JSON.stringify(handlers.listBody ?? []), {
        status: handlers.listStatus ?? 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response(`unexpected ${method} ${url}`, { status: 404 });
  }) as typeof fetch;

  return () => {
    globalThis.fetch = originalFetch;
  };
}

describe("RegistryClient.formatServiceEntry", () => {
  it("extracts card from agent_card and metadata forms", () => {
    const client = new RegistryClient(
      {
        enabled: true,
        baseUrl: CENTER,
        dataset: "openclaw_devices",
        serviceId: "HW-PC1",
        registerOnStart: false,
        discoverIntervalMs: 30_000,
        mergeWithStatic: true,
      },
      () => {},
    );

    const fromAgentCard = client.formatServiceEntry({
      id: "HW-Phone1",
      status: "online",
      agent_card: {
        name: "Phone",
        url: "http://x/a2a/jsonrpc",
        metadata: { tunnelDeviceId: "HW-Phone1" },
      },
    });
    assert.ok(fromAgentCard);
    assert.equal(fromAgentCard.serviceId, "HW-Phone1");
    assert.equal(fromAgentCard.tunnelDeviceId, "HW-Phone1");
    assert.equal(fromAgentCard.isSelf, false);
    assert.equal(fromAgentCard.agentCard.name, "Phone");

    const fromMetadata = client.formatServiceEntry({
      service_id: "HW-PC1",
      metadata: {
        name: "PC",
        url: "http://y/a2a/jsonrpc",
        skills: [{ id: "chat" }],
        metadata: { tunnelDeviceId: "HW-PC1" },
      },
    });
    assert.ok(fromMetadata);
    assert.equal(fromMetadata.isSelf, true);
    assert.equal(fromMetadata.tunnelDeviceId, "HW-PC1");
    assert.equal(fromMetadata.agentCard.name, "PC");
  });
});

describe("a2a.registry gateway methods", () => {
  it("registers gateway methods even when registry disabled", async () => {
    const harness = createHarness(makeConfig({ peers: [] }));
    assert.ok(harness.methods.has("a2a.registry.register"));
    assert.ok(harness.methods.has("a2a.registry.list"));

    const reg = await invokeGatewayMethod(harness, "a2a.registry.register", {});
    assert.equal(reg.ok, false);
    assert.match(String((reg.data as any)?.error || ""), /未启用/);

    const list = await invokeGatewayMethod(harness, "a2a.registry.list", {});
    assert.equal(list.ok, false);
  });

  it("a2a.registry.register POSTs Agent Card", async () => {
    let posted: Record<string, unknown> | undefined;
    const restore = mockRegistryFetch({
      onRegister: (body) => {
        posted = body;
      },
    });

    try {
      const harness = createHarness(registryConfig());
      const result = await invokeGatewayMethod(harness, "a2a.registry.register", {});
      assert.equal(result.ok, true);
      const data = result.data as Record<string, unknown>;
      assert.equal(data.ok, true);
      assert.equal(data.dataset, "openclaw_devices");
      assert.equal(data.serviceId, "HW-PC1");
      assert.equal(data.tunnelDeviceId, "HW-PC1");
      assert.ok(posted);
      assert.equal(posted.service_id, "HW-PC1");
      assert.ok(posted.agent_card && typeof posted.agent_card === "object");
      const card = posted.agent_card as Record<string, unknown>;
      assert.equal(card.name, "Test Agent");
      const meta = card.metadata as Record<string, unknown>;
      assert.equal(meta.tunnelDeviceId, "HW-PC1");
    } finally {
      restore();
    }
  });

  it("a2a.registry.list returns self + others with ids and cards", async () => {
    const restore = mockRegistryFetch({
      listBody: [
        {
          id: "HW-PC1",
          status: "online",
          agent_card: {
            name: "PC",
            url: "http://pc/a2a/jsonrpc",
            skills: [{ id: "chat", name: "chat" }],
            metadata: { tunnelDeviceId: "HW-PC1" },
          },
        },
        {
          id: "HW-Phone1",
          status: "online",
          metadata: {
            name: "Phone",
            url: "http://phone/a2a/jsonrpc",
            skills: [{ id: "chat" }],
            metadata: { tunnelDeviceId: "HW-Phone1" },
          },
        },
      ],
    });

    try {
      const harness = createHarness(registryConfig());
      const result = await invokeGatewayMethod(harness, "a2a.registry.list", {});
      assert.equal(result.ok, true);
      const data = result.data as Record<string, unknown>;
      assert.equal(data.ok, true);
      assert.equal(data.count, 2);
      assert.equal(data.selfServiceId, "HW-PC1");
      const services = data.services as Array<Record<string, unknown>>;
      assert.equal(services.length, 2);

      const self = services.find((s) => s.serviceId === "HW-PC1");
      const other = services.find((s) => s.serviceId === "HW-Phone1");
      assert.ok(self);
      assert.equal(self.isSelf, true);
      assert.equal(self.tunnelDeviceId, "HW-PC1");
      assert.equal((self.agentCard as any).name, "PC");

      assert.ok(other);
      assert.equal(other.isSelf, false);
      assert.equal(other.tunnelDeviceId, "HW-Phone1");
      assert.equal((other.agentCard as any).name, "Phone");
    } finally {
      restore();
    }
  });

  it("surfaces center HTTP errors", async () => {
    const restore = mockRegistryFetch({ listStatus: 503, listBody: { error: "down" } });
    try {
      const harness = createHarness(registryConfig());
      const result = await invokeGatewayMethod(harness, "a2a.registry.list", {});
      assert.equal(result.ok, false);
      assert.match(String((result.data as any)?.error || ""), /503/);
    } finally {
      restore();
    }
  });
});

describe("a2a_registry_* agent tools", () => {
  it("registers tools and list tool returns Chinese summary", async () => {
    const restore = mockRegistryFetch({
      listBody: [
        {
          id: "HW-PC1",
          agent_card: {
            name: "PC",
            url: "http://pc/a2a/jsonrpc",
            metadata: { tunnelDeviceId: "HW-PC1" },
          },
        },
      ],
    });

    try {
      const { tools } = registerPlugin(registryConfig());
      assert.ok(tools.get("a2a_registry_register"));
      assert.ok(tools.get("a2a_registry_list"));

      const listTool = tools.get("a2a_registry_list");
      const result = await listTool.execute("call-1", {});
      assert.equal(result.details.ok, true);
      assert.match(result.content[0].text, /注册中心设备列表/);
      assert.match(result.content[0].text, /HW-PC1/);
      assert.match(result.content[0].text, /tunnelDeviceId:/);
      assert.match(result.content[0].text, /AgentCard\.name:/);
      assert.ok(!/给助手/.test(result.content[0].text), "user-facing block must not include assistant hint");
      assert.match(result.content[1].text, /给助手/);
    } finally {
      restore();
    }
  });

  it("register tool succeeds against mock center", async () => {
    const restore = mockRegistryFetch({});
    try {
      const { tools } = registerPlugin(registryConfig());
      const tool = tools.get("a2a_registry_register");
      const result = await tool.execute("call-2", {});
      assert.equal(result.details.ok, true);
      assert.equal(result.details.serviceId, "HW-PC1");
      assert.match(result.content[0].text, /注册中心注册结果/);
      assert.match(result.content[0].text, /status: 成功/);
    } finally {
      restore();
    }
  });
});

describe("RegistryClient.listServicesDetailed", () => {
  it("includes self (unlike servicesToPeers)", async () => {
    const restore = mockRegistryFetch({
      listBody: {
        services: [
          { id: "HW-PC1", agent_card: { name: "PC", metadata: { tunnelDeviceId: "HW-PC1" } } },
          { id: "HW-Phone1", agent_card: { name: "Phone", metadata: { tunnelDeviceId: "HW-Phone1" } } },
        ],
      },
    });
    try {
      const client = new RegistryClient(
        {
          enabled: true,
          baseUrl: CENTER,
          dataset: "openclaw_devices",
          serviceId: "HW-PC1",
          registerOnStart: false,
          discoverIntervalMs: 30_000,
          mergeWithStatic: true,
        },
        () => {},
      );
      const detailed = await client.listServicesDetailed();
      assert.equal(detailed.length, 2);
      assert.ok(detailed.some((s) => s.isSelf));

      const peers = client.servicesToPeers([
        { id: "HW-PC1", agent_card: { name: "PC", metadata: { tunnelDeviceId: "HW-PC1" } } },
        { id: "HW-Phone1", agent_card: { name: "Phone", metadata: { tunnelDeviceId: "HW-Phone1" } } },
      ]);
      assert.equal(peers.length, 1);
      assert.equal(peers[0].name, "HW-Phone1");
    } finally {
      restore();
    }
  });
});
