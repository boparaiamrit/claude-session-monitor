//! Data shapes sent to the frontend. Field names are camelCase on the wire and
//! mirrored by `src/types.ts`.

use serde::Serialize;
use std::collections::HashMap;

#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

impl Usage {
    pub fn add(&mut self, o: &Usage) {
        self.input += o.input;
        self.output += o.output;
        self.cache_read += o.cache_read;
        self.cache_write += o.cache_write;
    }
    pub fn sub(&mut self, o: &Usage) {
        self.input = self.input.saturating_sub(o.input);
        self.output = self.output.saturating_sub(o.output);
        self.cache_read = self.cache_read.saturating_sub(o.cache_read);
        self.cache_write = self.cache_write.saturating_sub(o.cache_write);
    }
    pub fn prompt_tokens(&self) -> u64 {
        self.input + self.cache_read + self.cache_write
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub detail: String,
    pub ts: i64,
    pub end_ts: Option<i64>,
    pub ok: Option<bool>,
    pub file: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub role: String,
    pub text: String,
    pub ts: i64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileTouch {
    pub path: String,
    pub reads: u32,
    pub writes: u32,
    pub last_ts: i64,
}

#[derive(Serialize, Clone, Debug)]
pub struct Todo {
    pub content: String,
    pub status: String,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct HourStat {
    pub hour: i64,
    pub tools: u32,
    pub errors: u32,
    pub output: u64,
    pub input: u64,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct Counts {
    pub user: u32,
    pub assistant: u32,
    pub tools: u32,
    pub errors: u32,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    pub id: String,
    pub tool_use_id: Option<String>,
    pub agent_type: String,
    pub description: String,
    pub model: Option<String>,
    pub background: bool,
    pub started_at: Option<i64>,
    pub last_activity: Option<i64>,
    /// working | done | error
    pub status: String,
    pub current_tool: Option<ToolCall>,
    pub tool_count: u32,
    pub tools: Vec<ToolCall>,
    pub usage: Usage,
    pub last_text: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub pid: u32,
    pub kind: String,
    pub entrypoint: Option<String>,
    /// Human name of the app hosting the session ("VS Code", "Windows Terminal", ...)
    pub host: String,
    pub host_chain: Vec<String>,
    pub name: Option<String>,
    pub version: Option<String>,
    pub machine: String,
    pub cpu: f32,
    pub mem_mb: u64,
    pub started_at: Option<i64>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PendingPermission {
    pub id: String,
    pub tool_name: String,
    pub detail: String,
    pub input: serde_json::Value,
    pub ts: i64,
    /// Seconds the monitor will wait for a decision before handing back to the terminal
    pub hold_secs: u64,
    /// false once the hold expired and the terminal prompt took over
    pub held: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct QueuedMessage {
    pub id: String,
    pub text: String,
    pub ts: i64,
    /// Deliver at the next tool call (steer now) rather than when the turn ends
    pub steer: bool,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ControlState {
    /// Hook events have arrived from this session, so hook controls reach it
    pub hooks: bool,
    /// The monitor launched this session and owns its input stream
    pub managed: bool,
    pub managed_busy: bool,
    pub paused: bool,
    pub stop_requested: bool,
    pub queued: Vec<QueuedMessage>,
    pub pending: Option<PendingPermission>,
    pub notification: Option<String>,
    pub last_hook_at: Option<i64>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub project: String,
    pub project_name: String,
    pub cwd: Option<String>,
    pub title: Option<String>,
    pub model: Option<String>,
    pub version: Option<String>,
    pub git_branch: Option<String>,
    pub permission_mode: Option<String>,
    pub effort: Option<String>,
    pub entrypoint: Option<String>,
    pub started_at: Option<i64>,
    pub last_activity: Option<i64>,
    /// working | blocked | waiting | idle
    pub status: String,
    pub live: bool,
    pub process: Option<ProcessInfo>,
    pub control: ControlState,
    pub current_tool: Option<ToolCall>,
    pub thinking: Option<String>,
    pub last_prompt: Option<String>,
    pub last_text: Option<String>,
    pub counts: Counts,
    pub usage: Usage,
    pub usage_by_model: HashMap<String, Usage>,
    pub context_tokens: u64,
    pub tools: Vec<ToolCall>,
    pub messages: Vec<Message>,
    pub agents: Vec<Agent>,
    pub files: Vec<FileTouch>,
    pub todos: Vec<Todo>,
    /// Tool calls per minute for the last 60 minutes, oldest first
    pub activity: Vec<u32>,
    pub hourly: Vec<HourStat>,
    pub file_size: u64,
    pub transcript: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Delta {
    pub upserts: Vec<Session>,
    pub removed: Vec<String>,
    pub full: bool,
}
