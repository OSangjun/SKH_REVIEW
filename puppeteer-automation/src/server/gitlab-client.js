"use strict";

// GitLab REST API client.
// Reads GITLAB_URL, GITLAB_TOKEN, GITLAB_PROJECT from env.
// GITLAB_PROJECT is a project path like "group/repo"; the client URL-encodes it.

const https = require("https");
const http  = require("http");

const BASE    = (process.env.GITLAB_URL || "").replace(/\/$/, "");
const TOKEN   = process.env.GITLAB_TOKEN || "";
const PROJECT = process.env.GITLAB_PROJECT || "";

function projectId() {
  return encodeURIComponent(PROJECT);
}

function request(urlPath) {
  return new Promise((resolve, reject) => {
    const full = `${BASE}/api/v4${urlPath}`;
    const mod  = full.startsWith("https") ? https : http;
    const opts = { headers: { "PRIVATE-TOKEN": TOKEN } };
    mod.get(full, opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode >= 400) {
          reject(new Error(`GitLab ${res.statusCode}: ${body.slice(0, 200)}`));
        } else {
          try { resolve(JSON.parse(body)); }
          catch { resolve(body); }
        }
      });
    }).on("error", reject);
  });
}

function isConfigured() {
  return !!(BASE && TOKEN && PROJECT);
}

// List files/directories under `path` in the repository.
// Returns array of { id, name, type, path, mode }.
async function listFiles(path = "", ref = "main") {
  const p = encodeURIComponent(path);
  const r = encodeURIComponent(ref);
  const items = [];
  let page = 1;
  while (true) {
    const batch = await request(
      `/projects/${projectId()}/repository/tree?path=${p}&ref=${r}&per_page=100&page=${page}&recursive=false`
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    items.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return items;
}

// Get raw file content.
async function getFile(filePath, ref = "main") {
  const p = encodeURIComponent(filePath);
  const r = encodeURIComponent(ref);
  return request(`/projects/${projectId()}/repository/files/${p}/raw?ref=${r}`);
}

// Search code across the project. Returns array of { filename, ref, startline, data }.
async function searchCode(query) {
  const q = encodeURIComponent(query);
  return request(`/projects/${projectId()}/search?scope=blobs&search=${q}&per_page=20`);
}

// ── 동적 project 버전 (UI 소스 분석에서 매 호출마다 다른 프로젝트를 조회) ──
// `project` 는 "group/repo" 형태의 경로 또는 숫자 ID. 함수 내부에서 URL 인코딩.

function isReady() {
  return !!(BASE && TOKEN);
}

async function listFilesIn(project, path = "", ref = "main") {
  const pj = encodeURIComponent(project);
  const p  = encodeURIComponent(path);
  const r  = encodeURIComponent(ref);
  const items = [];
  let page = 1;
  while (true) {
    const batch = await request(
      `/projects/${pj}/repository/tree?path=${p}&ref=${r}&per_page=100&page=${page}&recursive=false`
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    items.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return items;
}

async function getFileIn(project, filePath, ref = "main") {
  const pj = encodeURIComponent(project);
  const p  = encodeURIComponent(filePath);
  const r  = encodeURIComponent(ref);
  return request(`/projects/${pj}/repository/files/${p}/raw?ref=${r}`);
}

async function searchCodeIn(project, query) {
  const pj = encodeURIComponent(project);
  const q  = encodeURIComponent(query);
  return request(`/projects/${pj}/search?scope=blobs&search=${q}&per_page=20`);
}

module.exports = {
  isConfigured, listFiles, getFile, searchCode,
  isReady, listFilesIn, getFileIn, searchCodeIn,
};
