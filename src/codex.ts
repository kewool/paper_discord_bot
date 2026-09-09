import type { CodexOptions } from "@openai/codex-sdk";

export function isolatedCodexOptions(instructions: string): CodexOptions {
  const env: Record<string, string> = {};
  for (const key of [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "LOCALAPPDATA",
    "APPDATA",
    "CODEX_HOME",
    "SSL_CERT_FILE",
    "CODEX_CA_CERTIFICATE",
  ]) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  return {
    env,
    configOverrides: ["mcp_servers={}", "plugins={}", "notify=[]"],
    config: {
      forced_login_method: "chatgpt",
      project_doc_max_bytes: 0,
      developer_instructions: instructions,
      features: {
        shell_tool: false,
        unified_exec: false,
        code_mode: false,
        code_mode_host: false,
        apps: false,
        plugins: false,
        browser_use: false,
        browser_use_external: false,
        computer_use: false,
        multi_agent: false,
        multi_agent_v2: false,
        image_generation: false,
        view_image: false,
        workspace_dependencies: false,
        skill_search: false,
        skip_host_skill_discovery: true,
        goals: false,
        sleep_tool: false,
        memories: false,
        hooks: false,
        in_app_browser: false,
        tool_suggest: false,
        remote_plugin: false,
      },
    },
  };
}
