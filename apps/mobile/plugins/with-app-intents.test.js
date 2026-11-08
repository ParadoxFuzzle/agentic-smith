import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const mobile = join(import.meta.dirname, "..");
const read = (file) => readFileSync(join(mobile, file), "utf8");
const constant = (file, name) => read(file).match(new RegExp(`${name} = "([^"]+)"`))?.[1];

describe("AgenticSmithIntents", () => {
  // The intents read what the app saved; renaming a key on one side would break them silently.
  it("reads the secure-store keys the app writes", () => {
    const swift = read("ios-intents/AgenticSmithIntents.swift");
    for (const [file, name] of [
      ["lib/session.ts", "SESSION_KEY"],
      ["lib/server-config.ts", "API_BASE_STORAGE_KEY"],
      ["lib/api.ts", "SPACE_KEY"],
      ["lib/last-bot.ts", "LAST_BOT_KEY"],
      ["lib/server-headers.ts", "SERVER_HEADERS_KEY"],
    ]) {
      const key = constant(file, name);
      expect(key, `${name} in ${file}`).toBeTruthy();
      expect(swift).toContain(`secureStoreItem("${key}")`);
    }
  });

  it("hands a voice chat to the module that reads it", () => {
    const swift = read("ios-intents/AgenticSmithIntents.swift");
    const module = read("modules/agentic-smith-voice-chat/ios/AgenticSmithVoiceChatModule.swift");
    expect(swift).toContain('"agentic-smith.pending_voice_chat"');
    expect(module).toContain('"agentic-smith.pending_voice_chat"');
    for (const source of [swift, module]) {
      expect(source).toContain('Notification.Name("AgenticSmithPendingVoiceChat")');
    }
  });

  it("falls back to the app's own default server", () => {
    const local = constant("lib/server-config.ts", "LOCAL_API");
    expect(read("plugins/with-app-intents.js")).toContain(`"${local}"`);
  });
});

describe("withAppIntents prebuild", () => {
  it("refreshes the sources without duplicating their build references", () => {
    const files = new Set();
    const copied = [];
    const added = [];
    const widgetSettings = { PRODUCT_NAME: '"AgenticSmithWidgets"' };
    const config = {
      version: "2.0.0",
      ios: { bundleIdentifier: "com.example.app", buildNumber: "7" },
      modRequest: { projectRoot: "/project", platformProjectRoot: "/project/ios" },
      modResults: {
        hasFile: (file) => files.has(file),
        pbxTargetByName: (name) => (name === "AgenticSmithWidgets" ? {} : undefined),
        pbxNativeTargetSection: () => ({
          "app-target": { name: "Agentic Smith" },
          "app-target_comment": "Agentic Smith",
          "widget-target": { name: '"AgenticSmithWidgets"' },
        }),
        pbxXCBuildConfigurationSection: () => ({ widget: { buildSettings: widgetSettings } }),
      },
    };
    const plist = { modResults: { UIBackgroundModes: ["audio"] } };
    const module = { exports: {} };
    runInNewContext(read("plugins/with-app-intents.js"), {
      module,
      __dirname: join(mobile, "plugins"),
      process: { env: { EXPO_PUBLIC_API_URL: "https://api.example.test" } },
      require: (name) => {
        if (name === "node:fs")
          return {
            copyFileSync: (...args) => copied.push(args),
            cpSync: (...args) => copied.push(args.slice(0, 2)),
          };
        if (name === "node:path") return { join };
        if (name === "./pbx-group") return createRequire(import.meta.url)("./pbx-group.js");
        if (name === "expo/config-plugins")
          return {
            withInfoPlist: (value, mod) => {
              mod(plist);
              return value;
            },
            withXcodeProject: (value, mod) => mod(value),
            IOSConfig: {
              XcodeUtils: {
                getProjectName: () => "Agentic Smith",
                addBuildSourceFileToGroup: (input) => {
                  // Like the real helper, a file already in its group is skipped.
                  const key = `${input.groupName}/${input.filepath}`;
                  if (!files.has(key)) added.push(input);
                  files.add(key);
                  files.add(input.filepath);
                },
              },
            },
          };
        throw new Error(`Unexpected module: ${name}`);
      },
    });
    module.exports(config);
    module.exports(config);
    expect(plist.modResults.AgenticSmithDefaultApiBase).toBe("https://api.example.test");
    expect(plist.modResults.UIBackgroundModes).toEqual(["audio"]);
    expect(copied).toContainEqual([
      join(mobile, "ios-intents/AgenticSmithIntents.swift"),
      "/project/ios/Agentic Smith/AgenticSmithIntents.swift",
    ]);
    expect(added.map((input) => input.filepath)).toEqual([
      "Agentic Smith/AgenticSmithIntents.swift",
      "Agentic Smith/VoiceMessageRecorder.swift",
      "Agentic Smith/VoiceMessageActivity.swift",
      "AgenticSmithWidgets.swift",
      "WorkLiveActivity.swift",
      "VoiceMessageActivity.swift",
      "WorkActivityAttributes.swift",
    ]);
    // An existing widget target still gets every source, in its own group and build phase.
    expect(added.slice(3).every((input) => input.targetUuid === "widget-target")).toBe(true);
    expect(added.slice(3).every((input) => input.groupName === "AgenticSmithWidgets")).toBe(true);
    expect(widgetSettings).toMatchObject({
      CURRENT_PROJECT_VERSION: "7",
      MARKETING_VERSION: "2.0.0",
    });
  });
});

describe("voice message Live Activity", () => {
  // EAS signs only the extensions app.json lists, under the bundle id the plugin gives them.
  it("lists the widget extension for EAS signing", () => {
    const app = JSON.parse(read("app.json")).expo;
    const [extension] = app.extra.eas.build.experimental.ios.appExtensions;
    expect(read("plugins/with-app-intents.js")).toContain(`"${extension.targetName}"`);
    expect(extension.bundleIdentifier).toBe(`${app.ios.bundleIdentifier}.widgets`);
  });
});
