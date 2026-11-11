/** Display and legacy client metadata migrated from 1agents_app. ACP launch support comes from the runtime registry. */
export const catalogDescriptors = [
  {
    "type": "claudecode",
    "label": "Claude Code",
    "binary": "claude",
    "acp_capable": true,
    "cli_capable": true,
    "cc_transport": "cli-stream",
    "integrated": true,
    "install_command": "npm install -g @anthropic-ai/claude-code"
  },
  {
    "type": "codex",
    "label": "Codex",
    "binary": "codex",
    "acp_capable": true,
    "cli_capable": true,
    "cc_transport": "cli-stream",
    "integrated": true,
    "install_command": "npm install -g @openai/codex"
  },
  {
    "type": "grok-build",
    "label": "Grok",
    "binary": "grok",
    "acp_capable": true,
    "cli_capable": true,
    "cc_transport": "acp",
    "integrated": true,
    "install_command": "curl -fsSL https://x.ai/cli/install.sh | bash"
  },
  {
    "type": "cursor",
    "label": "Cursor Agent",
    "binary": "agent",
    "acp_capable": true,
    "cli_capable": true,
    "cc_transport": "cli-stream",
    "integrated": true,
    "install_command": "curl https://cursor.com/install -fsS | bash"
  },
  {
    "type": "gemini",
    "label": "Gemini",
    "binary": "gemini",
    "acp_capable": true,
    "cli_capable": true,
    "cc_transport": "cli-stream",
    "integrated": true,
    "install_command": "npm install -g @google/gemini-cli"
  },
  {
    "type": "devin",
    "label": "Devin",
    "binary": "devin",
    "acp_capable": true,
    "cli_capable": true,
    "cc_transport": "acp",
    "integrated": true,
    "install_command": "curl -fsSL https://cli.devin.ai/install.sh | bash"
  },
  {
    "type": "iflow",
    "label": "iFlow",
    "binary": "iflow",
    "acp_capable": true,
    "cli_capable": true,
    "cc_transport": "cli-stream",
    "integrated": true,
    "install_command": "npm install -g @iflow-ai/iflow-cli"
  },
  {
    "type": "kimi",
    "label": "Kimi",
    "binary": "kimi",
    "acp_capable": true,
    "cli_capable": true,
    "cc_transport": "cli-stream",
    "integrated": true,
    "install_command": "uv tool install --python 3.13 kimi-cli"
  },
  {
    "type": "opencode",
    "label": "OpenCode",
    "binary": "opencode",
    "acp_capable": true,
    "cli_capable": true,
    "cc_transport": "cli-stream",
    "integrated": true,
    "install_command": "curl -fsSL https://opencode.ai/install | bash"
  },
  {
    "type": "pi",
    "label": "Pi",
    "binary": "pi",
    "acp_capable": true,
    "cli_capable": true,
    "cc_transport": "cli-stream",
    "integrated": true,
    "install_command": "npm install -g @mariozechner/pi-coding-agent"
  },
  {
    "type": "qoder",
    "label": "Qoder",
    "binary": "qodercli",
    "acp_capable": true,
    "cli_capable": true,
    "cc_transport": "cli-stream",
    "integrated": true,
    "install_command": "npm install -g @qoder-ai/qodercli"
  },
  {
    "type": "antigravity",
    "label": "Antigravity",
    "binary": "agy_acp_server.par",
    "acp_capable": true,
    "cli_capable": true,
    "cc_transport": "acp",
    "integrated": true,
    "install_command": "Install agy_acp_server and localharness_external from the same antigravity-acp release (https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json) onto PATH, and point ANTIGRAVITY_HARNESS_PATH at that helper"
  },
  {
    "type": "openhands",
    "label": "OpenHands",
    "binary": "openhands",
    "acp_capable": true,
    "cli_capable": true,
    "cc_transport": "",
    "integrated": false,
    "install_command": "uvx --python 3.12 --from openhands-ai openhands"
  },
  {
    "type": "trae",
    "label": "Trae",
    "binary": "trae-cli",
    "acp_capable": false,
    "cli_capable": true,
    "cc_transport": "",
    "integrated": false,
    "install_command": "git clone https://github.com/bytedance/trae-agent && cd trae-agent && uv sync --all-extras"
  },
  {
    "type": "openclaw",
    "label": "OpenClaw",
    "binary": "openclaw",
    "acp_capable": false,
    "cli_capable": true,
    "cc_transport": "",
    "integrated": false,
    "install_command": "npm install -g openclaw@latest"
  },
  {
    "type": "hermes",
    "label": "Hermes",
    "binary": "hermes",
    "acp_capable": true,
    "cli_capable": true,
    "cc_transport": "",
    "integrated": false,
    "install_command": "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash"
  }
];
