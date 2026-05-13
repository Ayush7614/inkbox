// tests/integration/cli/cli_lifecycle.test.ts

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  loadConfig,
  bootstrapTestOrg,
  cleanupTestOrg,
  inkbox,
  inkboxJson,
  logStep,
  pollUntil,
  type CliIntegrationConfig,
  type BootstrapResult,
} from "./helpers.js";

describe("CLI lifecycle", { timeout: 300_000 }, () => {
  let config: CliIntegrationConfig;
  let bootstrap: BootstrapResult;
  let cliOpts: { apiKey: string; baseUrl: string };

  beforeAll(async () => {
    config = loadConfig();
    bootstrap = await bootstrapTestOrg(config);
    cliOpts = { apiKey: bootstrap.apiKey, baseUrl: config.baseUrl };
  });

  afterAll(async () => {
    if (bootstrap) {
      await cleanupTestOrg(config, bootstrap);
    }
  });

  it("exercises the full CLI lifecycle", async () => {

    // ── whoami ──────────────────────────────────────────────────
    logStep(config, "whoami");
    const whoami = inkboxJson<{ organizationId: string }>("whoami", cliOpts);
    expect(whoami.organizationId).toBe(bootstrap.orgId);

    // ── empty state ────────────────────────────────────────────
    logStep(config, "verify empty identity list");
    const emptyList = inkboxJson<unknown[]>("identity list", cliOpts);
    expect(emptyList).toHaveLength(0);

    // ── create identities (mailbox + tunnel atomic) ───────────
    logStep(config, "create identity alpha");
    const alphaCreate = inkboxJson<{
      agentHandle: string;
      id: string;
      mailbox: string;
      tunnel: { id: string; publicHost: string; tlsMode: string; status: string };
    }>(
      "identity create alpha --description 'alpha cli-integration'",
      cliOpts,
    );
    expect(alphaCreate.agentHandle).toBe("alpha");
    expect(alphaCreate.mailbox).toBeTruthy();
    expect(alphaCreate.tunnel).not.toBeNull();
    expect(alphaCreate.tunnel.publicHost).toMatch(/^alpha\..+\.inkboxwire\.com$/);
    expect(alphaCreate.tunnel.tlsMode).toBe("edge");
    const alphaMb = { emailAddress: alphaCreate.mailbox };

    logStep(config, "create identity bravo");
    const bravoCreate = inkboxJson<{ mailbox: string; tunnel: { publicHost: string } }>(
      "identity create bravo",
      cliOpts,
    );
    expect(bravoCreate.mailbox).toBeTruthy();
    const bravoMb = { emailAddress: bravoCreate.mailbox };

    logStep(config, "list identities shows 2");
    const identities = inkboxJson<unknown[]>("identity list", cliOpts);
    expect(identities).toHaveLength(2);

    // ── tunnel get (smoke) ────────────────────────────────────
    logStep(config, "tunnel get alpha");
    const alphaTunnel = inkboxJson<{ tunnelName: string; tlsMode: string }>(
      "tunnel get alpha",
      cliOpts,
    );
    expect(alphaTunnel.tunnelName).toBe("alpha");
    expect(alphaTunnel.tlsMode).toBe("edge");

    // ── get identity ──────────────────────────────────────────
    logStep(config, "get identity alpha");
    const alphaGet = inkboxJson<{
      agentHandle: string;
      mailbox: string;
      description: string | null;
      tunnel: { publicHost: string };
    }>("identity get alpha", cliOpts);
    expect(alphaGet.agentHandle).toBe("alpha");
    expect(alphaGet.mailbox).toBe(alphaMb.emailAddress);
    expect(alphaGet.description).toBe("alpha cli-integration");
    expect(alphaGet.tunnel.publicHost).toBe(alphaCreate.tunnel.publicHost);

    // ── send email alpha → bravo ──────────────────────────────
    const subject = `cli-integration-${config.environment}`;
    logStep(config, `send email from alpha to bravo: ${subject}`);
    const sent = inkboxJson<{ id: string; subject: string }>(
      `email send -i alpha --to "${bravoMb.emailAddress}" --subject "${subject}" --body-text "Hello from CLI integration test!"`,
      cliOpts,
    );
    expect(sent.subject).toBe(subject);

    // ── poll for delivery ─────────────────────────────────────
    logStep(config, "poll for inbound delivery to bravo");
    const emailList = await pollUntil<{ id: string; subject: string; direction: string }[]>(
      "inbound message delivered to bravo",
      () =>
        inkboxJson<{ id: string; subject: string; direction: string }[]>(
          "email list -i bravo --direction inbound",
          cliOpts,
        ),
      {
        timeoutMs: config.pollTimeoutMs,
        intervalMs: config.pollIntervalMs,
        isReady: (msgs) => msgs.some((m) => m.subject === subject),
        verbose: config.verbose,
      },
    );
    const inboundMsg = emailList.find((m) => m.subject === subject)!;
    expect(inboundMsg.direction).toBe("inbound");

    // ── message detail ────────────────────────────────────────
    logStep(config, "get message detail");
    const detail = inkboxJson<{ bodyText: string; threadId: string }>(
      `email get ${inboundMsg.id} -i bravo`,
      cliOpts,
    );
    expect(detail.bodyText).toContain("CLI integration test");
    expect(detail.threadId).toBeTruthy();

    // ── mark read ─────────────────────────────────────────────
    logStep(config, "mark message as read");
    inkbox(`email mark-read ${inboundMsg.id} -i bravo`, cliOpts);

    // ── thread ────────────────────────────────────────────────
    logStep(config, "get thread");
    const thread = inkboxJson<{ id: string; subject: string; messages: unknown[] }>(
      `email thread ${detail.threadId} -i bravo`,
      cliOpts,
    );
    expect(thread.subject).toBe(subject);
    expect(thread.messages.length).toBeGreaterThanOrEqual(1);

    // ── forward bravo → alpha ─────────────────────────────────
    const forwardSubject = `Fwd: ${subject}`;
    logStep(
      config,
      `forward inbound message from bravo to alpha: ${forwardSubject}`,
    );
    const forwarded = inkboxJson<{ id: string; subject: string; status: string }>(
      `email forward ${inboundMsg.id} -i bravo --to "${alphaMb.emailAddress}" --body-text "Forwarded by CLI integration test!"`,
      cliOpts,
    );
    expect(forwarded.subject).toBe(forwardSubject);

    logStep(config, "poll for forwarded delivery to alpha");
    const alphaList = await pollUntil<{ id: string; subject: string; direction: string }[]>(
      "forwarded message delivered to alpha",
      () =>
        inkboxJson<{ id: string; subject: string; direction: string }[]>(
          "email list -i alpha --direction inbound",
          cliOpts,
        ),
      {
        timeoutMs: config.pollTimeoutMs,
        intervalMs: config.pollIntervalMs,
        isReady: (msgs) => msgs.some((m) => m.subject === forwardSubject),
        verbose: config.verbose,
      },
    );
    const forwardedInbound = alphaList.find((m) => m.subject === forwardSubject)!;
    expect(forwardedInbound.direction).toBe("inbound");

    // ── signing key ───────────────────────────────────────────
    logStep(config, "create signing key");
    const signingKey = inkboxJson<{ signingKey: string }>("signing-key create", cliOpts);
    expect(signingKey.signingKey).toBeTruthy();

    // ── cleanup: delete identities (cascades to mailbox + tunnel) ─
    logStep(config, "delete identities");
    inkbox("identity delete alpha", cliOpts);
    inkbox("identity delete bravo", cliOpts);

    logStep(config, "verify empty after cleanup");
    const finalList = inkboxJson<unknown[]>("identity list", cliOpts);
    expect(finalList).toHaveLength(0);

    // ── immediate re-create (no 24h grace) ────────────────────
    logStep(config, "re-create 'alpha' immediately");
    inkboxJson("identity create alpha", cliOpts);
    inkbox("identity delete alpha", cliOpts);
  });
});
