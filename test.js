
    /* ── Config ─────────────────────────────────────────────────────────────── */
    const API = 'http://127.0.0.1:8000/api';


    /* ── State ──────────────────────────────────────────────────────────────── */
    let currentSession = null;
    let sessions = [];
    let stats = { messages: 0, toolCalls: 0, toolBreakdown: {} };
    let kbDocs = [];

    /* ── Init ───────────────────────────────────────────────────────────────── */
    async function init() {
      await loadSessions();
      await newChat();
      loadKBDocs();
      loadSettings();
    }

    /* ── Sessions ────────────────────────────────────────────────────────────── */
    async function loadSessions() {
      try {
        const res = await fetch(`${API}/sessions`);
        sessions = await res.json();
        renderSessions();
        document.getElementById('stat-sessions').textContent = sessions.length;
      } catch (err) {
        /* backend offline – demo mode */ 
      }
    }
      function renderSessions() {
        const list = document.getElementById('sessions-list');
        if (!sessions.length) {
          list.innerHTML = '<div style="padding:8px 12px;font-size:11px;color:var(--text-dim)">No sessions yet.</div>';
          return;
        }
        list.innerHTML = sessions.map(s => `
    <div class="session-item ${s.session_id === currentSession ? 'active' : ''}"
         onclick="switchSession('${s.session_id}')">
      <span class="session-item-title">${s.title}</span>
      <button class="session-delete" onclick="deleteSession(event,'${s.session_id}')">✕</button>
    </div>`).join('');
      }

      async function newChat() {
        const title = 'Chat ' + new Date().toLocaleTimeString();
        try {
          const res = await fetch(`${API}/sessions`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title })
          });
          const s = await res.json();
          currentSession = s.session_id;
          sessions.unshift(s);
        } catch {
          currentSession = 'demo_' + Math.random().toString(36).slice(2);
          sessions.unshift({ session_id: currentSession, title });
        }
        renderSessions();
        showWelcome();
        document.getElementById('stat-sessions').textContent = sessions.length;
      }

      async function switchSession(sid) {
        currentSession = sid;
        renderSessions();
        try {
          const res = await fetch(`${API}/sessions/${sid}/messages`);
          const msgs = await res.json();

          showMessages();

          document.getElementById('messages').innerHTML = '';
          msgs.forEach(m => {
            if (m.role === 'user') appendMessage('user', m.content);
            else if (m.role === 'assistant') appendMessage('assistant', m.content, m.tool_calls);
          });
          scrollToBottom();
        } catch { showWelcome(); }
      }

      async function deleteSession(e, sid) {
        e.stopPropagation();
        try { await fetch(`${API}/sessions/${sid}`, { method: 'DELETE' }); } catch { }
        sessions = sessions.filter(s => s.session_id !== sid);
        if (currentSession === sid) { await newChat(); }
        renderSessions();
      }

      /* ── Chat ────────────────────────────────────────────────────────────────── */

      function showMessages() {
        document.getElementById('welcome').classList.add('hidden');
        document.getElementById('messages').classList.add('visible');
      }

      function showWelcome() {
        document.getElementById('welcome').classList.remove('hidden');
        document.getElementById('messages').classList.remove('visible');
      }

      function appendTypingIndicator() {
        const wrap = document.getElementById('messages');
        let typing = document.getElementById('typing');
        if (!typing) {
          typing = document.createElement('div');
          typing.className = 'typing-indicator';
          typing.id = 'typing';
          typing.innerHTML = `
        <div style="width:36px;height:36px;border-radius:10px;background:var(--surface2);
          border:1px solid var(--border2);display:flex;align-items:center;justify-content:center">⬡</div>
        <div>
          <div class="typing-dots">
            <div class="typing-dot"></div>
            <div class="typing-dot"></div>
            <div class="typing-dot"></div>
          </div>
          <div class="typing-text">ARIA is thinking…</div>
        </div>
      `;
          wrap.appendChild(typing);
        } else {
          wrap.appendChild(typing); // Move to bottom
        }
      }

      async function sendMessage() {
        const input = document.getElementById('chat-input');
        const text = input.value.trim();
        if (!text) return;
        input.value = '';
        autoResize(input);

        showMessages();

        appendMessage('user', text);
        showTyping(true);
        setInputEnabled(false);

        try {
          const res = await fetch(`${API}/chat/stream`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: currentSession, message: text })
          });

          showTyping(false);
          let msgDiv = appendMessage('assistant', '', null);
          let fullText = '';

          const reader = res.body.getReader();
          const decoder = new TextDecoder('utf-8');
          let buffer = '';

          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            let lines = buffer.split('\n');
            buffer = lines.pop(); // keep the last potentially incomplete line

            for (let i = 0; i < lines.length; i++) {
              const line = lines[i].trim();
              if (!line) continue;

              let dataStr = line;
              if (line.startsWith('data: ')) {
                dataStr = line.substring(6);
              } else if (line.startsWith('data:')) {
                dataStr = line.substring(5);
              } else {
                continue; // Not an SSE data stream payload
              }

              if (dataStr === '[DONE]') break;
              try {
                const data = JSON.parse(dataStr);
                if (data.chunk) {
                  fullText += data.chunk;
                  updateAssistantBubble(msgDiv, fullText, null);
                }
                if (data.tool_calls) {
                  updateAssistantBubble(msgDiv, fullText, data.tool_calls);
                  updateStats(data.tool_calls);
                }
                if (data.session_id) {
                  const sess = sessions.find(s => s.session_id === currentSession);
                  if (sess && sess.title.startsWith('Chat ')) {
                    sess.title = text.slice(0, 32) + (text.length > 32 ? '…' : '');
                    renderSessions();
                  }
                }
              } catch (e) {
                // Buffer it back if it's incomplete JSON, might just be a chunked payload from python
                // Though SSE is naturally lines, sometimes multiple SSE come without newline breaks.
                console.error("Parse error:", e, dataStr);
              }
            }
          }
        } catch (err) {
          showTyping(false);
          appendMessage('assistant', `⚠️ Could not reach the backend. Make sure the FastAPI server is running on port 8000.\n\n\`\`\`\ncd backend && uvicorn main:app --reload\n\`\`\``, []);
        }
        setInputEnabled(true);
        scrollToBottom();
      }

      function appendMessage(role, content, toolCalls) {
        const wrap = document.getElementById('messages');
        const div = document.createElement('div');
        div.className = `msg ${role}`;
        const avatar = role === 'user' ? '👤' : '⬡';

        let toolHtml = '';
        if (toolCalls && toolCalls.length) {
          toolHtml = `<div class="tool-cards">${toolCalls.map(renderToolCard).join('')}</div>`;
        }

        div.innerHTML = `
    <div class="msg-avatar">${avatar}</div>
    <div class="msg-bubble">
      ${escHtml(content).replace(/\n/g, '<br>').replace(/\`\`\`([\s\S]*?)\`\`\`/g,
          (_, c) => `<div class="code-block">${escHtml(c).trim()}</div>`)}
      ${toolHtml}
    </div>`;
        wrap.insertBefore(div, document.getElementById('typing'));
        stats.messages++;
        document.getElementById('stat-msgs').textContent = stats.messages;
        return div;
      }

      function updateAssistantBubble(div, content, toolCalls) {
        let toolHtml = '';
        if (toolCalls && toolCalls.length) {
          toolHtml = `<div class="tool-cards">${toolCalls.map(renderToolCard).join('')}</div>`;
        }
        const bubble = div.querySelector('.msg-bubble');
        if (bubble) {
          bubble.innerHTML = `
      ${escHtml(content).replace(/\n/g, '<br>').replace(/\`\`\`([\s\S]*?)\`\`\`/g,
            (_, c) => `<div class="code-block">${escHtml(c).trim()}</div>`)}
      ${toolHtml}
    `;
        }
        scrollToBottom();
      }

      function renderToolCard(tc) {
        const id = 'tc_' + Math.random().toString(36).slice(2);
        const badge = toolBadge(tc.tool);
        const icon = toolIcon(tc.tool);
        const body = renderToolResult(tc.tool, tc.result);
        return `
    <div class="tool-card">
      <div class="tool-card-header" onclick="toggleCard('${id}')">
        ${icon} <span class="${badge[0]}">${badge[1]}</span>
        <span style="font-size:11px;color:var(--text-dim);flex:1;margin-left:6px">${tc.tool.replace(/_/g, ' ')}</span>
        ${tc.result?.demo ? '<span style="font-size:9px;color:var(--gold);letter-spacing:1px">DEMO</span>' : ''}
        <span class="tool-card-toggle" id="${id}-toggle">▼</span>
      </div>
      <div class="tool-card-body" id="${id}">${body}</div>
    </div>`;
      }

      function toggleCard(id) {
        const body = document.getElementById(id);
        const tog = document.getElementById(id + '-toggle');
        const open = body.classList.toggle('open');
        tog.textContent = open ? '▲' : '▼';
      }

      function renderToolResult(tool, result) {
        if (!result) return '<div style="font-size:11px;color:var(--text-dim)">No result.</div>';
        switch (tool) {
          case 'send_email':
            return `<div class="send-confirm">
        <span class="check">✓</span>
        <div>
          <div style="font-size:12px">Email sent to <strong>${result.to}</strong></div>
          <div style="font-size:10px;color:var(--text-dim);margin-top:2px">Subject: ${result.subject}</div>
        </div></div>`;
          case 'read_emails':
            return (result.emails || []).map(e => `
        <div class="email-item">
          <div class="email-item-from">${escHtml(e.from || '')}</div>
          <div class="email-item-subj">${escHtml(e.subject || '(no subject)')}</div>
          <div class="email-item-snip">${escHtml(e.snippet || '')}</div>
          <div class="email-item-date">${e.date || ''} ${e.unread ? '<span style="color:var(--cyan)">● UNREAD</span>' : ''}</div>
        </div>`).join('');
          case 'schedule_meeting':
            return `<div class="send-confirm">
        <span class="check">📅</span>
        <div>
          <div style="font-size:12px"><strong>${escHtml(result.title || 'Meeting')}</strong></div>
          <div style="font-size:10px;color:var(--text-dim);margin-top:2px">${result.start ? new Date(result.start).toLocaleString() : ''}</div>
          ${result.meet_link ? `<a class="result-card-link" href="${result.meet_link}" target="_blank">🔗 Meet link</a>` : ''}
        </div></div>`;
          case 'list_calendar_events':
            return (result.events || []).map(e => {
              const dt = new Date(e.start);
              return `<div class="event-item">
          <div class="event-date-block">
            <div class="event-day">${dt.getDate()}</div>
            <div class="event-month">${dt.toLocaleString('default', { month: 'short' }).toUpperCase()}</div>
          </div>
          <div>
            <div class="event-info-title">${escHtml(e.summary || 'Event')}</div>
            <div class="event-info-time">${dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
          </div></div>`;
            }).join('');
          case 'search_youtube':
            return `<div class="tool-result-grid">${(result.videos || []).map(v => `
        <div class="result-card">
          <div class="result-card-title">${escHtml(v.title)}</div>
          <div class="result-card-meta">${escHtml(v.channel)} · ${v.duration || ''} · ${v.views || ''}</div>
          <a class="result-card-link" href="${v.url}" target="_blank">▶ Watch on YouTube</a>
        </div>`).join('')}</div>`;
          case 'search_spotify':
            return `<div class="tool-result-grid">${(result.results || []).map(t => `
        <div class="result-card">
          <div class="result-card-title">${escHtml(t.name)}</div>
          <div class="result-card-meta">${escHtml(t.artist || '')}${t.duration ? ' · ' + t.duration : ''}</div>
          <a class="result-card-link" href="${t.url}" target="_blank">🎵 Open in Spotify</a>
        </div>`).join('')}</div>`;
          case 'create_playlist':
            return `<div class="send-confirm">
        <span class="check">🎵</span>
        <div>
          <div style="font-size:12px">Playlist <strong>${escHtml(result.name || '')}</strong> created</div>
          ${result.url ? `<a class="result-card-link" href="${result.url}" target="_blank">Open in Spotify</a>` : ''}
        </div></div>`;
          case 'add_to_knowledge_base':
            if (result.status === 'QUEUED') {
              return `<div class="send-confirm">
           <span class="check" style="color:var(--gold)">⏳</span>
           <div style="font-size:12px">Queued for later "<strong>${escHtml(result.title || '')}</strong>" (Rate Limited)</div>
         </div>`;
            }
            return `<div class="send-confirm">
        <span class="check">🧠</span>
        <div style="font-size:12px">Saved "<strong>${escHtml(result.title || '')}</strong>" (${result.chars} chars)</div>
      </div>`;
          case 'search_knowledge_base':
            if (!result.results?.length) return '<div style="font-size:11px;color:var(--text-dim)">No matching documents found.</div>';
            return result.results.map(r => `
        <div class="kb-doc-item">
          <div class="kb-doc-title">${escHtml(r.title)} <span style="color:var(--text-faint)">· ${(r.score * 100).toFixed(0)}%</span></div>
          <div class="kb-doc-snippet">${escHtml(r.content.slice(0, 200))}…</div>
        </div>`).join('');
          default:
            return `<div class="code-block">${escHtml(JSON.stringify(result, null, 2))}</div>`;
        }
      }

      function toolBadge(tool) {
        if (tool.includes('email')) return ['tool-badge badge-email', 'EMAIL'];
        if (tool.includes('calendar') || tool.includes('meeting')) return ['tool-badge badge-calendar', 'CALENDAR'];
        if (tool.includes('youtube')) return ['tool-badge badge-youtube', 'YOUTUBE'];
        if (tool.includes('spotify') || tool.includes('playlist')) return ['tool-badge badge-spotify', 'SPOTIFY'];
        if (tool.includes('knowledge')) return ['tool-badge badge-knowledge', 'KNOWLEDGE'];
        return ['tool-badge badge-default', 'TOOL'];
      }

      function toolIcon(tool) {
        const icons = {
          send_email: '📤', read_emails: '📬',
          schedule_meeting: '📅', list_calendar_events: '🗓',
          search_youtube: '▶️', search_spotify: '🎵', create_playlist: '➕',
          add_to_knowledge_base: '💾', search_knowledge_base: '🔍',
        };
        return `<span style="font-size:14px">${icons[tool] || '⚙'}</span>`;
      }

      /* ── Knowledge Base Panel ─────────────────────────────────────────────────── */
      async function saveToKB() {
        const title = document.getElementById('kb-title').value.trim();
        const content = document.getElementById('kb-content').value.trim();
        if (!title || !content) { showToast('Please enter a title and content.'); return; }
        try {
          const res = await fetch(`${API}/knowledge`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title, content })
          });
          const data = await res.json();

          document.getElementById('kb-title').value = '';
          document.getElementById('kb-content').value = '';

          if (data.status === 'QUEUED') {
            showToast('⏳ Queued for Knowledge Base (Rate Limited)');
          } else {
            showToast('✓ Saved to knowledge base');
          }
          loadKBDocs();
        } catch { showToast('Backend offline – KB save skipped in demo.'); }
      }

      async function loadKBDocs() {
        try {
          const res = await fetch(`${API}/knowledge/search?q=&top_k=20`);
          // Just use the endpoint to confirm connection; display static seeds
        } catch { }
        // Display seeded docs
        const seeded = [
          { title: 'Company Policies', snippet: 'Vacation: 15 days/yr. Remote: up to 3 days/wk. Expenses within 30 days…' },
          { title: 'Project Roadmap', snippet: 'Q1: MVP. Q2: Mobile app. Q3: Enterprise. Q4: International expansion…' },
        ];
        document.getElementById('kb-docs').innerHTML = seeded.map(d => `
    <div class="kb-doc-item">
      <div class="kb-doc-title">${escHtml(d.title)}</div>
      <div class="kb-doc-snippet">${escHtml(d.snippet)}</div>
    </div>`).join('');
      }

      /* ── Stats ───────────────────────────────────────────────────────────────── */
      function updateStats(toolCalls) {
        stats.toolCalls += toolCalls.length;
        document.getElementById('stat-tools').textContent = stats.toolCalls;
        toolCalls.forEach(tc => {
          stats.toolBreakdown[tc.tool] = (stats.toolBreakdown[tc.tool] || 0) + 1;
        });
        renderToolUsage();
      }

      function renderToolUsage() {
        const entries = Object.entries(stats.toolBreakdown).sort((a, b) => b[1] - a[1]);
        document.getElementById('tool-usage-list').innerHTML = entries.length
          ? entries.map(([t, c]) => `
        <div class="tool-usage-item">
          <span class="tool-usage-name">${t.replace(/_/g, ' ')}</span>
          <span class="tool-usage-count">${c}</span>
        </div>`).join('')
          : '<div style="font-size:11px;color:var(--text-dim)">No tools used yet.</div>';
      }

      /* ── UI helpers ──────────────────────────────────────────────────────────── */
      function showWelcome() {
        document.getElementById('welcome').classList.remove('hidden');
        document.getElementById('messages').classList.remove('visible');
      }
      function showMessages() {
        document.getElementById('welcome').classList.add('hidden');
        document.getElementById('messages').classList.add('visible');
      }
      function appendTypingIndicator() {
        const wrap = document.getElementById('messages');
        wrap.appendChild(document.getElementById('typing'));
      }
      function showTyping(v) {
        document.getElementById('typing').classList.toggle('visible', v);
        scrollToBottom();
      }
      function scrollToBottom() {
        const m = document.getElementById('messages');
        m.scrollTop = m.scrollHeight;
      }
      function setInputEnabled(v) {
        document.getElementById('chat-input').disabled = !v;
        document.getElementById('send-btn').disabled = !v;
      }
      function switchTab(i) {
        document.querySelectorAll('.panel-tab').forEach((t, j) => t.classList.toggle('active', i === j));
        document.querySelectorAll('.panel-section').forEach((s, j) => s.classList.toggle('active', i === j));
      }
      function handleKey(e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
      }
      function autoResize(el) {
        el.style.height = 'auto';
        el.style.height = Math.min(el.scrollHeight, 140) + 'px';
      }
      function useChip(el) {
        document.getElementById('chat-input').value = el.textContent.replace(/^[^\s]+\s/, '');
        sendMessage();
      }
      function showToast(msg) {
        const t = document.getElementById('toast');
        t.textContent = msg; t.classList.add('show');
        setTimeout(() => t.classList.remove('show'), 2800);
      }
      function escHtml(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      }

      /* ── Settings ────────────────────────────────────────────────────────────── */
      async function loadSettings() {
        try {
          const res = await fetch(`${API}/settings`);
          const s = await res.json();

          // Demo toggle
          const tog = document.getElementById('toggle-demo');
          if (tog) {
            tog.checked = s.DEMO_MODE;
            updateDemoSlider(s.DEMO_MODE);
          }
          document.getElementById('demo-badge').classList.toggle('visible', s.DEMO_MODE);

          // Status badges
          if (s.spotify_configured) {
            document.getElementById('sp-status').textContent = '✅ Credentials saved  ' + (s.SPOTIFY_CLIENT_ID || '');
          }
          if (s.gmail_token_exists) {
            document.getElementById('gmail-status').textContent = '✅ Gmail token found — connected';
          } else if (s.gmail_creds_exists) {
            document.getElementById('gmail-status').textContent = '⚠️ credentials.json found — click Connect to authorise';
          } else if (s.SMTP_EMAIL) {
            document.getElementById('gmail-status').textContent = '✅ Using alternative SMTP dispatch';
          }
        } catch (e) { /* backend offline */ }
      }

      function updateDemoSlider(on) {
        const sl = document.getElementById('demo-slider');
        const kn = document.getElementById('demo-knob');
        if (!sl || !kn) return;
        sl.classList.toggle('on', on);
        kn.classList.toggle('on', on);
      }

      async function toggleDemo(checked) {
        updateDemoSlider(checked);
        document.getElementById('demo-badge').classList.toggle('visible', checked);
        await fetch(`${API}/settings`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ DEMO_MODE: checked })
        });
        showToast(checked ? '⚠ Demo mode ON' : '🔴 Demo mode OFF — live APIs active');
      }

      async function saveSettings() {
        const payload = {};
        const g = document.getElementById('set-gemini').value.trim();
        const si = document.getElementById('set-sp-id').value.trim();
        const ss = document.getElementById('set-sp-sec').value.trim();
        const yt = document.getElementById('set-yt').value.trim();
        const qu = document.getElementById('set-qd-url').value.trim();
        const qk = document.getElementById('set-qd-key').value.trim();
        const se = document.getElementById('set-smtp-em').value.trim();
        const sp = document.getElementById('set-smtp-pw').value.trim();
        if (g) payload.GEMINI_API_KEY = g;
        if (si) payload.SPOTIFY_CLIENT_ID = si;
        if (ss) payload.SPOTIFY_CLIENT_SECRET = ss;
        if (yt) payload.YOUTUBE_API_KEY = yt;
        if (qu) payload.QDRANT_URL = qu;
        if (qk) payload.QDRANT_API_KEY = qk;
        if (se) payload.SMTP_EMAIL = se;
        if (sp) payload.SMTP_PASSWORD = sp;
        if (!Object.keys(payload).length) { showToast('Nothing to save'); return; }

        const res = await fetch(`${API}/settings`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        showToast('✅ Saved: ' + data.updated.join(', '));
        // Clear password fields (do not clear URL or Email)
        ['set-gemini', 'set-sp-sec', 'set-yt', 'set-qd-key', 'set-smtp-pw'].forEach(id => {
          const el = document.getElementById(id); if (el) el.value = '';
        });
        if (si) document.getElementById('sp-status').textContent = '✅ Credentials saved';
      }

      async function connectSpotify() {
        const si = document.getElementById('set-sp-id').value.trim();
        const ss = document.getElementById('set-sp-sec').value.trim();
        if (si && ss) await saveSettings();
        const statusEl = document.getElementById('sp-status');
        statusEl.textContent = 'Opening Spotify authorisation…';
        const win = window.open('http://localhost:8000/auth/spotify', '_blank', 'width=500,height=700');
        // Poll until callback succeeds
        let attempts = 0;
        const poll = setInterval(async () => {
          attempts++;
          if (attempts > 60) { clearInterval(poll); return; }
          try {
            const r = await fetch('http://localhost:8000/auth/spotify/status');
            const d = await r.json();
            if (d.connected) {
              clearInterval(poll);
              statusEl.textContent = '✅ Spotify connected!';
              showToast('🎵 Spotify connected!');
              if (win && !win.closed) win.close();
            }
          } catch { }
        }, 2000);
      }

      async function connectGmail() {
        const statusEl = document.getElementById('gmail-status');
        statusEl.textContent = 'Opening Gmail authorisation…';
        const win = window.open('http://localhost:8000/auth/gmail', '_blank', 'width=500,height=700');
        let attempts = 0;
        const poll = setInterval(async () => {
          attempts++;
          if (attempts > 90) { clearInterval(poll); return; }
          try {
            const r = await fetch('http://localhost:8000/auth/gmail/status');
            const d = await r.json();
            if (d.connected) {
              clearInterval(poll);
              statusEl.textContent = '✅ Gmail connected!';
              showToast('📧 Gmail connected!');
              if (win && !win.closed) win.close();
            }
          } catch { }
        }, 2000);
      }

      /* ── Boot ────────────────────────────────────────────────────────────────── */
      init();
  