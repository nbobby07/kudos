const icons = {
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 11h18m-13 4h2m4 0h2"/>',
  chat: '<path d="M21 11a8 8 0 0 1-8 8H8l-5 3V7a5 5 0 0 1 5-5h5a8 8 0 0 1 8 9Z"/><path d="M7 8h9M7 12h6"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>', check: '<path d="m5 12 4 4L19 6"/>', contract: '<path d="M8 3H5v18h14V3h-3M9 3h6v4H9zM8 12h8m-8 4h5"/>', inbox: '<path d="M4 4h16v16H4zM4 13h5l2 3h2l2-3h5"/>', bolt: '<path d="m13 2-9 12h7l-1 8 10-12h-7z"/>', close: '<path d="m6 6 12 12M6 18 18 6"/>', link: '<path d="m10 13 4-4M8 15l-2 2a4 4 0 0 1-6-6l4-4m12 2 2-2a4 4 0 0 1 6 6l-4 4" transform="translate(1 0)"/>', people: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3m2-16a3 3 0 0 1 0 6m1 4a5 5 0 0 1 3 5"/>', clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.grid}</svg>`;
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
let state, view = 'board', tab = 'requirements', viewer = sessionStorage.getItem('relay-viewer') || 'Aryan', selected = 'Aryan', connected = false;
const app = document.querySelector('#app');
const names = ['Aryan', 'Noel', 'Kiran'];
let chatPeer = null, chatSending = false;
let calendarDay = 3;
let calendarMonth = '2026-10';
const taskAuthor = task => names.includes(task.source) ? task.source : names.includes(task.createdBy) ? task.createdBy : viewer;
const taskDueLabel = task => task.dueDate ? new Date(task.dueDate + 'T12:00:00').toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) + ' · ' + task.dueTime : '';
const chatDrafts = {};
const conversationMessages = (peer, owner = viewer) => (state.messages || []).filter(m => peer === 'group' ? m.to === 'group' : m.from === owner && m.to === peer || m.from === peer && m.to === owner);
const conversationName = peer => peer === 'group' ? 'Kiran + Noel' : peer;
const unreadMessages = peer => conversationMessages(peer).filter(m => m.from !== viewer && m.sentAt > (state.chatReadAt?.[`${viewer}:${peer}`] || '')).length;
let assistantThreadCleanup;
let assistantThreadModule;
let messagesInitialized = false;
let reviewTaskId = null, reviewPrNumber = 42, reviewSending = false;
const reviewDrafts = {};
const activeReview = () => (state.prReviews || []).filter(r => r.owner === viewer && r.taskId === reviewTaskId && r.prNumber === reviewPrNumber).at(-1);
const seenMessageIds = new Set();
const readingConversation = peer => view === 'chat' && chatPeer === peer && document.visibilityState === 'visible' && document.hasFocus();
const statuses = () => ({ Aryan: state.run?.status === 'running' ? 'Verifying' : state.run?.status === 'failed' || state.run?.status === 'unverified' ? 'Blocked' : state.run?.status === 'passed' && state.run.fixed === state.fixed && state.run.contractVersion === state.contractVersion ? 'Ready' : 'Working', Noel: state.handoff ? 'Working' : 'Blocked', Kiran: 'Blocked' });
const pill = (text, cls = '') => `<span class="pill ${cls || text.toLowerCase().replaceAll(' ', '-')}"><i></i>${esc(text)}</span>`;
function render() {
  if (!state) return;
  const openProfiles = [...document.querySelectorAll('.teammate-profile[open]')].map(el => el.dataset.profile);
  const oldMessages = document.querySelector('.chat-messages');
  const chatPosition = oldMessages ? { bottom: oldMessages.scrollHeight - oldMessages.scrollTop - oldMessages.clientHeight < 60, top: oldMessages.scrollTop } : null;
  const active = document.activeElement;
  const reviewFocus = active?.id === 'review-text' ? { start: active.selectionStart, end: active.selectionEnd } : null;
  const chatFocus = active?.closest('#chat-form') && ['chat-title', 'chat-text'].includes(active.id) ? { id: active.id, start: active.selectionStart, end: active.selectionEnd } : null;
  assistantThreadCleanup?.();
  assistantThreadCleanup = undefined;
  document.body.classList.toggle('day-view', view === 'board');
  document.body.classList.toggle('chat-view', view === 'chat');
  document.body.classList.toggle('calendar-view', view === 'calendar');
  const status = statuses();
  const passed = state.run?.results.filter(r => r.outcome === 'Passed').length || 0;
  app.innerHTML = `<aside class="sidebar">
    <a class="brand" href="/" aria-label="Kudos home"><span class="brand-symbol">${icon('arrow')}${icon('arrow')}</span>kudos<span class="brand-dot">.</span></a>
    <div class="workspace"><span class="workspace-icon">C</span><div>Checkout team<small>CoShell workspace</small></div><span class="chevron">⌄</span></div>
    <div class="nav-label">WORKSPACE</div>
    <nav>${[['board', 'grid', 'My day'], ['chat', 'chat', 'Team chat'], ['calendar', 'calendar', 'Calendar'], ['handoff', 'bolt', 'Verification']].map(([id, ico, title]) => { const count = id === 'chat' ? [...names.filter(n => n !== viewer), 'group'].reduce((sum, peer) => sum + unreadMessages(peer), 0) : 0; return `<button class="nav-item ${view === id ? 'active' : ''}" data-view="${id}" aria-label="${title}">${icon(ico)}${title}${count ? `<span class="nav-count">${count}</span>` : ''}</button>`; }).join('')}</nav>
    <div class="sidebar-note"><span class="tiny-label">BETTER TOGETHER</span><h3>Good work.<br>Clear handoffs.</h3><p>Give your next teammate the confidence to move forward.</p><div class="mini-avatars"><span>A</span><span>N</span><span>K</span><small>One shared project</small></div></div>
    <div class="sidebar-bottom"><span class="connection ${connected ? 'online' : ''}"></span>${connected ? 'Shared workspace live' : 'Reconnecting...'}<span class="small-tag">MVP</span></div>
  </aside>
  <div class="shell"><header class="topbar"><div class="breadcrumb">Workspace <span>/</span> <strong>Checkout project</strong></div><div class="viewer"><span>Viewing as</span><select id="viewer" aria-label="Demo teammate view">${names.map(n => `<option ${viewer === n ? 'selected' : ''}>${n}</option>`).join('')}</select><span class="avatar small ${viewer.toLowerCase()}">${viewer[0]}</span></div></header>
  <main><div class="page-heading"><div class="eyebrow">${view === 'board' ? 'YOUR SPACE TO MOVE THINGS FORWARD' : 'THE NEXT STEP STARTS HERE'}</div><div class="heading-row"><div><h1>${view === 'calendar' ? 'A little room for what comes next.' : view === 'chat' ? 'Your messages. Nothing missed.' : view === 'board' ? `Hey ${viewer}, let's make progress.` : 'A clear handoff starts here.'}</h1><p>${view === 'calendar' ? 'Your October at a glance. Today is Saturday, October 3.' : view === 'chat' ? 'Your DMs, your group, and the ideas worth keeping.' : view === 'board' ? 'These are your tasks for today. One step at a time, then over to your team.' : 'Check the agreed requirements before delivering a verified handoff.'}</p></div><button class="button secondary" data-action="share">${icon('link')}Share workspace</button></div></div>
  ${!['board', 'chat', 'calendar'].includes(view) ? `<div class="demo-banner"><span>${icon('bolt')} INTERACTIVE DEMO</span><p>Shared state is live. Verification and evidence are simulated; Freestyle is not connected.</p><button data-action="share">Copy team link ${icon('link')}</button></div>` : ''}
    ${view === 'board' ? dailyDashboard() : view === 'chat' ? chatScreen() : view === 'calendar' ? calendarScreen() : `
  <div class="section-title"><h2>Team handoffs <span>03</span></h2><span>${icon('people')} One team. Connected work.</span></div>
  <section class="team-grid">${names.map((n, i) => `<button class="team-card ${selected === n ? 'selected' : ''}" data-person="${n}"><div class="card-top"><span class="avatar ${n.toLowerCase()}">${n[0]}</span>${pill(status[n])}</div><div class="person-name">${n}<span>${['Frontend', 'Backend', 'Quality assurance'][i]}</span></div><h3>${esc([state.assignment, 'Checkout backend', 'Integration testing'][i])}</h3><p>${['A checkout experience ready for the API.', 'The API that brings checkout to life.', 'Make sure the pieces work together.'][i]}</p><div class="card-dependency"><span>DEPENDS ON</span><div>${icon('link')}${['Agreed API contract', 'Verified frontend handoff', 'Frontend + backend handoffs'][i]}</div></div><div class="card-footer"><span>${i === 0 ? 'Handoff to Noel' : i === 1 ? 'Handoff to Kiran' : 'Handoff to the team'}</span>${icon('arrow')}</div></button>`).join('')}</section>
  ${selected === 'Aryan' ? detail(passed) : teammateDetail(selected)}
  `}
   <footer>Built for the space between teammates.<span>kudos / CoShell</span></footer></main></div>`;
  bind();
  const reviewNav = document.createElement('button');
  reviewNav.className = `nav-item ${view === 'reviews' ? 'active' : ''}`;
  reviewNav.innerHTML = `${icon('contract')}PR reviews`;
  reviewNav.onclick = () => { view = 'reviews'; render(); };
  document.querySelector('.sidebar nav').append(reviewNav);
  if (view === 'reviews') {
    document.querySelector('main').innerHTML = reviewScreen();
    bindReviews();
    const review = activeReview();
    const thread = document.querySelector('#review-messages');
    if (thread && review?.messages.length) {
      assistantThreadModule ??= import('/generated/assistant-thread.js');
      assistantThreadModule.then(({ mountReviewThread }) => {
        if (!thread.isConnected) return;
        assistantThreadCleanup = mountReviewThread(thread, { messages: review.messages, onNew: () => {} });
        thread.scrollTop = thread.scrollHeight;
      }).catch(() => { if (thread.isConnected) thread.textContent = 'Assistant chat could not load. Refresh to try again.'; });
    }
    if (reviewFocus) { const field = document.querySelector('#review-text'); if (field) { field.focus({ preventScroll: true }); field.setSelectionRange(reviewFocus.start, reviewFocus.end); } }
  }
  if (view === 'board') {
    document.querySelectorAll('[data-task]').forEach(input => {
      const label = input.closest('label');
      const button = document.createElement('button');
      button.className = 'text-button task-pr-link';
      button.textContent = 'Link a PR / AI review';
      button.onclick = () => { reviewTaskId = input.dataset.task; reviewPrNumber = viewer === 'Noel' ? 43 : viewer === 'Kiran' ? 44 : 42; view = 'reviews'; render(); };
      label.after(button);
    });
  }
  openProfiles.forEach(name => { const profile = document.querySelector(`.teammate-profile[data-profile="${name}"]`); if (profile) profile.open = true; });
  const messages = document.querySelector('.chat-messages');
  if (messages) {
    const from = viewer, peer = chatPeer;
    const threadMessages = conversationMessages(peer, from);
    assistantThreadModule ??= import('/generated/assistant-thread.js');
    assistantThreadModule.then(({ mountAssistantThread }) => {
      if (!messages.isConnected) return;
      assistantThreadCleanup = mountAssistantThread(messages, {
        messages: threadMessages, viewer: from, peer: conversationName(peer), tasks: state.daily[from].tasks,
        onAddTask: messageId => request('add-task', { from, id: `chat-${messageId}` }),
        onRemove: id => request('remove-task', { from, id }),
        onOpenPlan: () => { view = 'board'; render(); },
        onNew: async message => {
          const text = message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
          if (!await request('chat', { from, to: peer, text, kind: 'message' })) throw new Error('The message could not be sent.');
        },
      });
      messages.scrollTop = !chatPosition || chatPosition.bottom ? messages.scrollHeight : chatPosition.top;
      if (readingConversation(peer)) acknowledgeVisibleConversation();
    }).catch(() => {
      if (messages.isConnected) { messages.textContent = 'Chat could not load. Refresh to try again.'; toast('Assistant UI could not load. Your saved messages are unchanged.'); }
    });
  }
  if (chatFocus) { const field = document.getElementById(chatFocus.id); if (field) { field.focus({ preventScroll: true }); field.setSelectionRange(chatFocus.start, chatFocus.end); } }
}
function dailyDashboard() {
  const day = state.daily?.[viewer];
  if (!day) return '<section class="panel empty-state"><h2>Your task list is loading.</h2><p>Reconnect to the updated shared workspace.</p></section>';
  const completed = day.tasks.filter(t => t.completed).length;
  const ready = day.tasks.length > 0 && completed === day.tasks.length;
  const suggestions = day.recommendations.filter(r => !day.tasks.some(t => t.id === r.id));
  return `<div class="plan-workspace"><div class="plan-columns">
    <section class="panel daily-tasks" aria-labelledby="today-title"><div class="daily-panel-heading"><div><span class="eyebrow">YOUR PLAN</span><h2 id="today-title">My tasks for today</h2></div><span class="task-count ${ready ? 'complete' : ''}">${completed} of ${day.tasks.length} done</span></div><div class="daily-progress" role="progressbar" aria-label="Today's task completion" aria-valuenow="${completed}" aria-valuemin="0" aria-valuemax="${Math.max(1, day.tasks.length)}"><span style="width:${day.tasks.length ? completed / day.tasks.length * 100 : 0}%"></span></div>
    <div class="task-list">${day.tasks.length ? day.tasks.map(task => `<div class="daily-task ${task.completed ? 'done' : ''}" data-author="${taskAuthor(task)}"><label class="task-toggle"><input type="checkbox" data-task="${esc(task.id)}" ${task.completed ? 'checked' : ''} aria-label="${esc(task.title)}"><span class="task-checkbox">${icon('check')}</span><span class="task-copy"><strong>${esc(task.title)}</strong>${task.source ? `<span class="task-source">Task by ${esc(task.source)}</span>` : task.createdBy ? `<span class="task-source">Added by ${esc(task.createdBy)}</span>` : ''}<span>${esc(task.description)}</span>${task.dueDate ? `<span class="task-due">${icon('calendar')}Due ${esc(taskDueLabel(task))}</span>` : ''}</span></label><button type="button" class="task-delete" data-remove-task="${esc(task.id)}" aria-label="Delete ${esc(task.title)}" title="Delete task">${icon('trash')}</button></div>`).join('') : '<p class="tasks-empty">Your list is clear. Add a new task when you are ready.</p>'}</div>
    <button class="new-task-button" data-action="new-task"><span aria-hidden="true">+</span>Add a new task</button><div class="plan-completion">${icon(ready ? 'check' : 'clock')}<span>${ready ? 'All done. Send your plan to a teammate below.' : 'Check off your plan to unlock sending.'}</span></div></section>
    <section class="panel recommendations" aria-labelledby="ai-title"><div class="daily-panel-heading"><div><span class="eyebrow">A SECOND PERSPECTIVE</span><h2 id="ai-title">Recommended by AI</h2></div>${icon('bolt')}</div><p class="recommendations-intro">A few thoughtful next steps. Your call.</p><div class="suggestion-list">${suggestions.length ? suggestions.map(r => `<article class="suggestion" data-author="${taskAuthor(r)}"><div>${r.source ? `<span class="chat-source">${icon('chat')}Recommended by ${esc(r.source)}</span>` : ''}<h3>${esc(r.title)}</h3><p>${esc(r.description)}</p><span class="suggestion-reason">${esc(r.reason)}</span><div class="suggestion-actions"><button class="button secondary" data-add-task="${esc(r.id)}" aria-label="Add ${esc(r.title)} to my tasks">+ Add to my tasks</button>${r.source ? `<button class="text-button" data-open-chat="${esc(r.conversation || r.source)}">Open chat ${icon('arrow')}</button>` : ''}</div></div></article>`).join('') : `<div class="suggestions-empty">${icon('check')}<h3>Your plan has everything suggested.</h3><p>Focus on what you've already picked up.</p></div>`}</div><div class="recommendation-disclaimer">Teammate recommendations come from chat. Other suggestions are curated; AI is not connected yet.</div></section>
  </div><section class="team-dock" aria-label="Your teammates"><div class="dock-heading"><h2>Your teammates</h2><p>Hover for context. Send when you're ready.</p></div><div class="dock-members">
  ${names.filter(n => n !== viewer).map(n => { const sent = state.deliveries?.find(d => d.from === viewer && d.to === n && d.version === day.version); const recommendation = day.tasks.find(task => task.source === n); const role = n === 'Aryan' ? 'Frontend' : n === 'Noel' ? 'Backend' : 'Integration testing'; return `<div class="dock-member"><details class="teammate-profile" data-profile="${n}"><summary aria-label="View ${n}'s details"><span class="avatar ${n.toLowerCase()}">${n[0]}</span><span class="member-name"><strong>${n}</strong><span>${role}</span></span><span class="member-expand">${icon('people')}</span></summary><article class="rail-card"><div class="profile-heading"><h3>${n}</h3><span>${role}</span></div>${recommendation ? `<div class="rail-recommendation"><span class="rail-section-label">RECOMMENDS FOR YOU</span><h4>${esc(recommendation.title)}</h4><p>${esc(recommendation.description)}</p><span class="recommendation-tracking ${recommendation.completed ? 'completed' : ''}">${icon(recommendation.completed ? 'check' : 'link')}${recommendation.completed ? 'Completed in your tasks' : 'Already in your tasks'}</span></div>` : ''}<div class="rail-context"><span>THEIR TASK</span><h4>${n === 'Aryan' ? esc(state.assignment) : n === 'Noel' ? 'Checkout backend' : 'Integration testing'}</h4><span>THEIR NEXT STEP</span><p>${n === 'Aryan' ? 'Connect the checkout experience to the agreed API.' : n === 'Noel' ? 'Build the checkout API around the frontend contract.' : 'Test the complete flow once both handoffs are ready.'}</p></div></article></details><button class="button ${ready ? 'primary' : 'secondary'} send-task-button" data-send="${n}" ${!ready || sent ? 'disabled' : ''}>${icon(sent ? 'check' : 'arrow')}${sent ? `Sent to ${n}` : `Send to ${n}`}</button></div>`; }).join('')}
  </div></section><div class="workspace-footnote"><span>Demo teammate requests · Sending shares self-reported completion.</span><button class="text-button" data-view="handoff">Contract verification ${icon('arrow')}</button></div></div>`;
}
function chatScreen() {
  const peerName = conversationName(chatPeer);
  const draft = chatDrafts[`${viewer}:${chatPeer}`] ??= { text: '', title: '', kind: 'message' };
  const contacts = [...names.filter(n => n !== viewer).sort(), 'group'];
  const inbox = `<aside class="chat-contacts"><div class="inbox-heading"><h2>Messages</h2><span>${contacts.length}</span></div><span class="eyebrow">YOUR CONVERSATIONS</span>${contacts.map(peer => { const last = conversationMessages(peer).at(-1); const unread = unreadMessages(peer); return `<button class="chat-contact ${peer === chatPeer ? 'active' : ''}" data-chat-peer="${peer}" aria-label="Open ${conversationName(peer)} conversation" aria-pressed="${peer === chatPeer}"><span class="avatar ${peer === 'group' ? 'group-avatar' : peer.toLowerCase()}">${peer === 'group' ? icon('people') : peer[0]}</span><span class="contact-copy"><strong>${conversationName(peer)}</strong><small>${last ? esc((last.from === viewer ? 'You' : last.from) + ': ' + last.text) : peer === 'group' ? 'You, Kiran, and Noel' : 'Start a conversation'}</small></span>${unread ? `<span class="unread-count">${unread}</span>` : ''}</button>`; }).join('')}<div class="auto-save-setting"><label><input type="checkbox" id="auto-save" aria-label="Auto-add task ideas" ${state.taskPreferences?.[viewer] !== false ? 'checked' : ''}><span>Auto-add task ideas</span></label><p>Missed recommendations go straight to your to-do list after ${state.taskDelaySeconds || 30}s. No date needed.</p><small>Rule-based demo, not AI interpretation.</small></div></aside>`;
  if (!chatPeer) return `<section class="panel chat-layout inbox-only">${inbox}<div class="inbox-welcome"><div class="inbox-symbol">${icon('chat')}</div><span class="eyebrow">A LITTLE CONTEXT GOES A LONG WAY</span><h2>Your team, one conversation away.</h2><p>Choose a DM or the group chat. Task ideas stay connected to the person who suggested them.</p><div class="inbox-task-hint">${icon('check')}Add an idea to your to-do list, or let auto-add catch it.</div></div></section>`;
  return `<section class="panel chat-layout has-conversation">${inbox}<div class="chat-room"><div class="chat-room-heading"><button class="icon-button chat-back" data-chat-back aria-label="Back to all messages">${icon('arrow')}</button><span class="avatar ${chatPeer === 'group' ? 'group-avatar' : chatPeer.toLowerCase()}">${chatPeer === 'group' ? icon('people') : chatPeer[0]}</span><div><h2>${peerName}</h2><p>${chatPeer === 'group' ? 'Group · Aryan, Kiran, Noel' : 'Direct message · Checkout project'}</p></div>${pill('Live', 'neutral')}</div>
  <div class="chat-messages" role="log" aria-label="Conversation with ${peerName}" aria-live="polite"><p class="chat-loading">Loading conversation...</p></div>
  <form id="chat-form" class="chat-composer"><div class="composer-toolbar"><label for="chat-kind">Send as</label><select id="chat-kind" aria-label="Message type" ${chatSending ? 'disabled' : ''}><option value="message" ${draft.kind === 'message' ? 'selected' : ''}>Message</option><option value="recommendation" ${draft.kind === 'recommendation' ? 'selected' : ''}>Recommend a task</option></select></div>${draft.kind === 'recommendation' ? `<label class="composer-title" for="chat-title">Task title<input id="chat-title" required maxlength="120" value="${esc(draft.title)}" placeholder="What's your task idea?" ${chatSending ? 'disabled' : ''}></label>` : ''}<label class="sr-only" for="chat-text">Message to ${peerName}</label><textarea id="chat-text" required maxlength="2000" placeholder="${draft.kind === 'recommendation' ? 'Explain your suggestion and why it matters...' : `Message ${peerName}...`}" ${chatSending ? 'disabled' : ''}>${esc(draft.text)}</textarea><div class="composer-bottom"><p>${draft.kind === 'recommendation' ? `Attributed to ${viewer}, ready for ${chatPeer === 'group' ? 'your teammates\' to-do lists' : peerName + '\'s to-do list'}.` : 'Use “Recommend a task” to send an idea they can add to their to-do list.'}</p><button type="submit" class="button primary" ${chatSending ? 'disabled' : ''}>${chatSending ? 'Sending...' : draft.kind === 'recommendation' ? 'Send recommendation' : 'Send message'}${icon('arrow')}</button></div></form></div></section>`;
}
function calendarScreen() {
  const slots = [[3, '09:30'], [3, '14:00'], [9, '10:00'], [9, '15:30'], [16, '11:00'], [23, '13:30'], [29, '16:00'], [30, '10:30']];
  const month = new Date(calendarMonth + '-01T12:00:00');
  const year = month.getFullYear(), monthIndex = month.getMonth();
  const monthName = month.toLocaleDateString('en-US', { month: 'long' });
  const leading = (month.getDay() + 6) % 7;
  const days = new Date(year, monthIndex + 1, 0).getDate();
  const previousDays = new Date(year, monthIndex, 0).getDate();
  const tasks = state.daily[viewer].tasks.map((task, index) => {
    if (task.dueDate) return { ...task, date: task.dueDate, time: task.dueTime, example: false };
    if (task.id.startsWith('custom-')) return null;
    const [day, time] = slots[index % slots.length];
    return { ...task, date: `2026-10-${String(day).padStart(2, '0')}`, time, example: true };
  }).filter(Boolean).filter(task => task.date.startsWith(calendarMonth + '-')).sort((a, b) => a.time.localeCompare(b.time));
  const agenda = tasks.filter(task => Number(task.date.slice(-2)) === calendarDay);
  const cells = Array.from({ length: Math.ceil((leading + days) / 7) * 7 }, (_, index) => {
    const day = index - leading + 1;
    if (day < 1 || day > days) return `<div class="month-day outside"><span>${day < 1 ? previousDays + day : day - days}</span></div>`;
    const today = calendarMonth === '2026-10' && day === 3;
    const due = tasks.filter(task => Number(task.date.slice(-2)) === day);
    return `<button class="month-day ${today ? 'today' : ''} ${day === calendarDay ? 'selected' : ''}" data-calendar-day="${day}" aria-label="${monthName} ${day}, ${year}, ${due.length} tasks${today ? ', today' : ''}" aria-pressed="${day === calendarDay}" ${today ? 'aria-current="date"' : ''}><span class="day-number">${day}</span><span class="day-events">${due.slice(0, 2).map(task => `<span class="day-event ${task.completed ? 'done' : ''}" data-author="${taskAuthor(task)}" title="${esc(task.title)} · ${task.time}${task.example ? ' · Example date' : ''}"><time>${task.time}</time><span>${esc(task.title)}</span></span>`).join('')}${due.length > 2 ? `<small>+${due.length - 2} more</small>` : ''}</span>${due.length ? `<span class="day-count">${due.length} ${due.length === 1 ? 'task' : 'tasks'}</span>` : ''}</button>`;
  }).join('');
  return `<div class="month-layout"><section class="panel month-panel"><div class="month-header"><div><span class="eyebrow">A MONTH OF SMALL STEPS</span><h2>${monthName} <span>${year}</span></h2></div><div class="month-controls"><button class="icon-button month-previous" data-month-step="-1" aria-label="Previous month">${icon('arrow')}</button><button class="button secondary" data-calendar-today>Today · Oct 3</button><button class="icon-button" data-month-step="1" aria-label="Next month">${icon('arrow')}</button></div></div><div class="month-weekdays">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(day => `<span>${day}</span>`).join('')}</div><div class="month-grid">${cells}</div><div class="month-legend"><span><i></i>Today</span><div class="author-legend">${names.map(name => `<span data-author="${name}"><i></i>${name}</span>`).join('')}</div></div></section><aside class="panel month-agenda"><div class="agenda-heading"><span class="eyebrow">${calendarMonth === '2026-10' && calendarDay === 3 ? 'DUE TODAY' : 'ON YOUR HORIZON'}</span><h2>${monthName} ${calendarDay}</h2><p>${agenda.length} ${agenda.length === 1 ? 'task' : 'tasks'} on your plan</p></div>${agenda.length ? agenda.map(task => `<article class="agenda-task" data-author="${taskAuthor(task)}"><time>${task.time}</time><div><h3>${esc(task.title)}</h3><p>${esc(task.description)}</p><span class="task-source">${task.source ? 'Task by ' + esc(task.source) : 'Added by ' + taskAuthor(task)}</span>${task.example ? '<span class="example-deadline">Example date</span>' : '<span class="actual-deadline">Your due date · Local time</span>'}<span class="agenda-state">${icon(task.completed ? 'check' : 'clock')}${task.completed ? 'Completed' : 'To do'}</span></div></article>`).join('') : `<div class="agenda-clear">${icon('check')}<h3>A little breathing room.</h3><p>No deadlines on this day.</p></div>`}<button class="text-button agenda-plan-link" data-view="board">Back to my tasks ${icon('arrow')}</button></aside></div><p class="month-demo-note">${icon('calendar')}New task deadlines appear automatically. Entries marked “Example date” are not real deadlines. Times use your local 24-hour clock.</p>`;
}
function detail(passed) {
  return `<section class="panel handoff-panel"><div class="panel-heading"><div><div class="eyebrow">UP NEXT · FRONTEND → BACKEND</div><h2>${esc(state.assignment)} <span class="heading-arrow">→</span> Noel</h2><p>Can Noel safely build on what Aryan has delivered?</p></div><div class="handoff-action">${pill('Contract v' + state.contractVersion, 'neutral')}<button class="button primary" data-action="verify" ${state.run?.status === 'running' ? 'disabled' : ''}>${icon(state.run?.status === 'running' ? 'clock' : 'bolt')}${state.run?.status === 'running' ? 'Verifying handoff...' : 'Verify & Send to Noel'}${icon('arrow')}</button></div></div>
  <div class="tabs" role="tablist">${[['requirements', 'Requirements', '04'], ['contract', 'API contract', ''], ['verification', 'Verification', state.run ? '01' : ''], ['evidence', 'Evidence', '']].map(([id, title, count]) => `<button role="tab" aria-selected="${tab === id}" class="${tab === id ? 'active' : ''}" data-tab="${id}">${title}${count ? `<span>${count}</span>` : ''}</button>`).join('')}</div>
  <div class="detail-grid"><div class="detail-content">${tab === 'requirements' ? `<div class="content-heading"><h3>The promises we're checking</h3><span>${passed}/4 passed${state.run ? ' in last run' : ''}</span></div>${state.requirements.map((req, i) => { const result = state.run?.results.find(r => r.id === req.id); return `<article class="requirement"><span class="requirement-icon ${result?.outcome === 'Passed' ? 'passed' : result?.outcome === 'Failed' ? 'failed' : ''}">${result?.outcome === 'Passed' ? icon('check') : result?.outcome === 'Failed' ? '!' : '0' + (i + 1)}</span><div><h4>${esc(req.name)}</h4><p>${esc(req.promise)}</p><div class="verify-method"><span>HOW WE VERIFY</span>${esc(req.verify)}</div></div>${result ? `<span class="result ${result.outcome.toLowerCase()}">${result.outcome}</span>` : ''}</article>`; }).join('')}` : tab === 'contract' ? contract() : tab === 'verification' ? verification() : evidence() }</div><aside class="preview-side">${preview()}<div class="demo-controls"><div><strong>Demo scenario</strong><span>${state.fixed ? 'Declined payment handled' : 'Missing payment error handling'}</span></div><button class="switch ${state.fixed ? 'on' : ''}" role="switch" aria-checked="${state.fixed}" aria-label="Enable fixed checkout demo" data-action="fix" ${state.run?.status === 'running' ? 'disabled' : ''}><span></span></button></div><p class="preview-disclaimer">This is an illustrative preview, not a live browser test. Toggle the demo fix, then verify again.</p></aside></div>
  <div class="panel-foot">${icon('contract')}A passing handoff verifies this contract. It doesn't mean the work has no bugs.<span>Required checks only</span></div></section>`;
}
function contract() {
  return `<div class="api-header"><span class="method">POST</span><code>/checkout</code>${pill('Agreed contract', 'ready')}</div><div class="contract-grid"><div><h4>Request body</h4><pre>{
  "cartId": "string",
  "paymentToken": "string"
}</pre></div><div><h4>Success response</h4><pre>{ "orderId": "string" }</pre><h4>Failure response</h4><pre>{
  "code": "PAYMENT_DECLINED",
  "message": "string"
}</pre></div></div><div class="contract-note">${icon('people')}Noel can define the API before it exists. Aryan can verify against mocked responses.</div><button class="button secondary" data-action="edit">Edit requirements</button>`;
}
function verification() {
  const run = state.run;
  if (!run) return `<div class="empty-state">${icon('bolt')}<h3>A clear handoff starts with a check.</h3><p>Run the demo to see requirements, evidence, and downstream impact come together.</p><button class="button primary" data-action="verify">Verify & Send to Noel ${icon('arrow')}</button></div>`;
  const steps = ['Capture demo revision and contract', 'Prepare simulated checkout preview', 'Check loading and successful payment', 'Check declined payment and retry', 'Check mobile layout and prepare report'];
  return `<div class="run-banner ${run.status}"><strong>${run.status === 'running' ? 'Checking the handoff...' : run.status === 'failed' ? 'Handoff blocked' : run.status === 'passed' ? 'All required checks passed · Demo' : 'Verification incomplete'}</strong><p>${run.status === 'running' ? 'Everyone in the workspace sees this same run.' : run.status === 'failed' ? '1 required check failed. No ready handoff was sent to Noel.' : run.status === 'passed' ? 'A simulated verified handoff has been delivered to Noel.' : esc(run.error || 'Checks are unverified. Try again.')}</p></div><div class="run-meta"><code>${esc(run.revision)}</code><span>Contract v${run.contractVersion}</span><span>Simulated run</span></div><div class="timeline">${steps.map((s, i) => `<div class="timeline-step ${run.step > i ? 'complete' : run.step === i && run.status === 'running' ? 'current' : ''}"><span>${run.step > i ? icon('check') : i + 1}</span><div>${s}<small>${run.step > i ? 'Simulation completed' : run.step === i && run.status === 'running' ? 'In progress' : 'Waiting'}</small></div></div>`).join('')}</div>${run.status === 'failed' ? finding() : ''}`;
}
function finding() {
  return `<article class="finding"><div class="finding-label">${pill('Failed')} REQUIRED CHECK</div><h3>Payment failure is not handled</h3><dl><dt>Evidence</dt><dd>The simulated declined response leaves checkout blank, with no error or retry action.</dd><dt>Why Noel cares</dt><dd>The agreed backend failure response cannot be safely consumed by the UI.</dd><dt>Required fix</dt><dd>Display the error message and restore the checkout action so the customer can retry.</dd></dl><button class="text-button" data-tab="evidence">Inspect demo evidence ${icon('arrow')}</button></article>`;
}
function evidence() {
  if (!state.run || state.run.status === 'running') return `<div class="empty-state">${icon('contract')}<h3>${state.run ? 'Evidence is being prepared.' : 'Evidence belongs to a specific run.'}</h3><p>Complete verification to inspect the simulated results. Real screenshots and code references will come with the worker integration.</p></div>`;
  return `<div class="content-heading"><h3>Evidence from the last run</h3><span>Simulated, not measured</span></div><div class="evidence-table">${state.run.requirements.map(req => `<div><span>${esc(req.name)}</span>${pill(state.run.results.find(r => r.id === req.id)?.outcome || 'Unverified')}</div>`).join('')}</div>${state.run.status === 'failed' ? finding() : '<div class="success-note">All required demo checks passed. Real browser evidence is not connected yet.</div>'}<div class="run-meta"><code>${esc(state.run.revision)}</code><span>Contract v${state.run.contractVersion}</span></div>`;
}
function preview() {
  const run = state.run;
  const testing = run?.status === 'running';
  const failed = run?.status === 'failed' || testing && run.step >= 3 && !run.fixed;
  const fixed = testing ? run.fixed : state.fixed;
  return `<div class="preview-label"><span>${icon('grid')} CHECKOUT PREVIEW</span><span class="preview-live">${testing ? 'SIMULATING' : 'DEMO'}</span></div><div class="browser-frame"><div class="browser-bar"><div><i></i><i></i><i></i></div><span>checkout.local / preview</span>${icon('link')}</div><div class="checkout ${failed ? 'broken' : ''}">${failed ? `<div class="broken-preview"><span>!</span><strong>Something's missing.</strong><p>A declined payment leaves this screen blank.</p><small>Illustrative failure state</small></div>` : `<div class="store-brand">FORM & FIELD<span>CHECKOUT</span></div><h3>The everyday essentials.</h3><p class="store-sub">Good things, on their way to you.</p><div class="product"><div class="product-image"><div class="bag"><span>f.</span></div></div><div><strong>Everyday tote</strong><span>Natural / One size</span><small>Qty 1</small></div><strong>$38.00</strong></div><div class="price-line"><span>Subtotal</span><span>$38.00</span></div><div class="price-line"><span>Shipping</span><span>On us</span></div><div class="price-line total"><strong>Total</strong><strong>$38.00</strong></div>${fixed ? '<div class="payment-error">Your payment was declined. Try another card.</div>' : ''}<button class="checkout-button" data-action="checkout" ${testing ? 'disabled' : ''}>${testing ? 'Processing payment...' : fixed ? 'Try again' : 'Complete checkout'}${icon('arrow')}</button><p class="secure-note">Secure checkout · Demo store</p>`}</div></div>`;
}
function teammateDetail(person) {
  return `<section class="panel teammate-detail"><span class="avatar ${person.toLowerCase()}">${person[0]}</span><div><span class="eyebrow">${person === 'Noel' ? 'BACKEND HANDOFF' : 'INTEGRATION HANDOFF'}</span><h2>${person === 'Noel' ? 'Ready to build on the frontend?' : 'Bring the pieces together.'}</h2><p>${person === 'Noel' ? 'Noel needs valid requests, predictable response handling, and the shared API contract. Backend verification is outside this MVP.' : 'Kiran needs both verified frontend and backend handoffs. Integration checks will be connected after the first handoff works end to end.'}</p></div>${person === 'Noel' && state.handoff ? '<button class="button primary" data-action="view-verification">View verification</button>' : pill('Awaiting dependencies', 'blocked')}</section>`;
}
function toast(text) { const el = document.querySelector('#toast'); el.textContent = text; el.classList.add('visible'); clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove('visible'), 4000); }
function acceptState(snapshot) {
  if (!Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 0 || state && snapshot.sequence < state.sequence) return false;
  state = snapshot;
  return true;
}
async function request(endpoint, data) {
  try { const response = await fetch('/api/' + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data || {}) }); if (!response.ok) { const result = await response.json(); throw new Error(result.error || 'Request failed'); } if (acceptState(await response.json())) render(); return true; } catch (error) { toast(error.message); return false; }
}
function bind() {
  document.querySelectorAll('[data-calendar-day]').forEach(el => el.onclick = () => { calendarDay = Number(el.dataset.calendarDay); render(); });
  document.querySelectorAll('[data-calendar-today]').forEach(el => el.onclick = () => { calendarMonth = '2026-10'; calendarDay = 3; render(); });
  document.querySelectorAll('[data-month-step]').forEach(el => el.onclick = () => {
    const month = new Date(calendarMonth + '-01T12:00:00');
    month.setMonth(month.getMonth() + Number(el.dataset.monthStep));
    calendarMonth = `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}`;
    calendarDay = Math.min(calendarDay, new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate());
    render();
  });
  const autoSave = document.querySelector('#auto-save');
  if (autoSave) autoSave.onchange = event => request('task-preferences', { owner: viewer, enabled: event.target.checked });
  document.querySelectorAll('[data-chat-back]').forEach(el => el.onclick = () => { chatPeer = null; render(); });
  document.querySelectorAll('[data-open-chat]').forEach(el => el.onclick = () => { chatPeer = el.dataset.openChat; view = 'chat'; render(); });
  document.querySelectorAll('[data-chat-peer]').forEach(el => el.onclick = () => { chatPeer = el.dataset.chatPeer; render(); });
  const chatForm = document.querySelector('#chat-form');
  if (chatForm) {
    const key = `${viewer}:${chatPeer}`;
    const draft = chatDrafts[key];
    document.querySelector('#chat-kind').onchange = event => { draft.kind = event.target.value; render(); };
    document.querySelector('#chat-text').oninput = event => { draft.text = event.target.value; };
    document.querySelector('#chat-text').onkeydown = event => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      if (!event.repeat && !chatSending && draft.text.trim()) chatForm.requestSubmit();
    };
    const title = document.querySelector('#chat-title');
    if (title) title.oninput = event => { draft.title = event.target.value; };
    chatForm.onsubmit = async event => {
      event.preventDefault(); if (chatSending) return;
      const input = { from: viewer, to: chatPeer, ...draft };
      chatSending = true; render();
      const sent = await request('chat', input);
      if (sent) { draft.text = ''; draft.title = ''; }
      chatSending = false; render();
      if (sent) document.querySelector('#chat-text')?.focus({ preventScroll: true });
    };
  }
  document.querySelectorAll('.teammate-profile').forEach(profile => {
    profile.onpointerenter = event => { if (event.pointerType === 'mouse') profile.open = true; };
    profile.onpointerleave = () => { if (!profile.contains(document.activeElement)) profile.open = false; };
    profile.onfocusout = event => { if (!profile.contains(event.relatedTarget)) profile.open = false; };
    profile.onkeydown = event => { if (event.key === 'Escape') { profile.open = false; profile.querySelector('summary').focus(); } };
    profile.ontoggle = () => { if (profile.open) document.querySelectorAll('.teammate-profile').forEach(other => { if (other !== profile) other.open = false; }); };
  });
  document.querySelectorAll('[data-view]').forEach(el => el.onclick = () => { view = el.dataset.view; if (view === 'chat') chatPeer = null; render(); });
  document.querySelectorAll('[data-tab]').forEach(el => el.onclick = () => { tab = el.dataset.tab; render(); });
  document.querySelectorAll('[data-person]').forEach(el => el.onclick = () => { selected = el.dataset.person; render(); });
  document.querySelector('#viewer').onchange = event => { viewer = event.target.value; sessionStorage.setItem('relay-viewer', viewer); chatPeer = null; view = 'board'; document.querySelector('#message-notifications').replaceChildren(); render(); };
  document.querySelectorAll('[data-task]').forEach(el => el.onchange = async () => { el.disabled = true; await request('task', { from: viewer, id: el.dataset.task, completed: el.checked }); render(); });
  document.querySelectorAll('[data-remove-task]').forEach(el => el.onclick = async () => { el.disabled = true; if (await request('remove-task', { from: viewer, id: el.dataset.removeTask })) toast('Task deleted from your plan.'); render(); });
  document.querySelectorAll('[data-add-task]').forEach(el => el.onclick = async () => { el.disabled = true; await request('add-task', { from: viewer, id: el.dataset.addTask }); render(); });
  document.querySelectorAll('[data-send]').forEach(el => el.onclick = async () => { const to = el.dataset.send; el.disabled = true; if (await request('send', { from: viewer, to, version: state.daily[viewer].version })) toast(`Your completed task list was sent to ${to}.`); render(); });
  document.querySelectorAll('[data-action]').forEach(el => el.onclick = async () => {
    const action = el.dataset.action;
    if (action === 'verify') { tab = 'verification'; await request('verify'); }
    if (action === 'fix') await request('fix');
    if (action === 'view-verification') { selected = 'Aryan'; tab = 'verification'; view = 'handoff'; render(); }
    if (action === 'checkout') toast('Demo preview only. Use Verify & Send to run the shared simulation.');
    if (action === 'share') { try { await navigator.clipboard.writeText(location.href); toast('Team link copied. Teammates can choose their demo view.'); } catch { toast('Share this browser address with your team: ' + location.href); } }
    if (action === 'edit') openEditor();
    if (action === 'new-task') openNewTask();
  });
}
function openNewTask() {
  const from = viewer;
  let saving = false;
  const dialog = document.createElement('dialog');
  dialog.innerHTML = `<form><div class="drawer-heading"><div><span class="eyebrow">${esc(from.toUpperCase())}'S PLAN</span><h2>Add a new task</h2></div><button type="button" class="icon-button" aria-label="Close new task dialog">${icon('close')}</button></div><p>A small next step, added directly to your tasks for today.</p><label>Task title<input name="title" required maxlength="120" placeholder="What would you like to get done?" autofocus></label><label>Details (optional)<textarea name="description" maxlength="1000" placeholder="A little context, if you need it."></textarea></label><div class="task-deadline-fields"><label>Due date<input name="dueDate" type="date"></label><label>Due time<input name="dueTime" type="time"></label></div><p class="deadline-hint">Optional. Set both to automatically show this task in Calendar. Time is local to you.</p><button type="submit" class="button primary">Add task ${icon('arrow')}</button></form>`;
  document.body.append(dialog); dialog.showModal();
  dialog.querySelector('[type="button"]').onclick = () => dialog.close();
  dialog.onclose = () => dialog.remove();
  const dateField = dialog.querySelector('[name="dueDate"]'), timeField = dialog.querySelector('[name="dueTime"]');
  const updateDeadlineRequired = () => { dateField.required = timeField.required = Boolean(dateField.value || timeField.value); };
  dateField.oninput = timeField.oninput = updateDeadlineRequired;
  dialog.querySelector('form').onsubmit = async event => {
    event.preventDefault(); if (saving) return;
    const data = new FormData(event.target);
    const button = dialog.querySelector('[type="submit"]');
    saving = true; button.disabled = true;
    if (await request('create-task', { from, title: data.get('title'), description: data.get('description'), dueDate: data.get('dueDate'), dueTime: data.get('dueTime') })) { dialog.close(); toast(data.get('dueDate') ? 'Task added to your plan and calendar.' : 'New task added to your plan.'); }
    else { saving = false; button.disabled = false; }
  };
}
function openEditor() {
  if (state.run?.status === 'running') { toast('Wait for verification to finish before changing the contract.'); return; }
  const version = state.contractVersion;
  const dialog = document.createElement('dialog');
  dialog.innerHTML = `<form id="contract-form"><div class="drawer-heading"><div><span class="eyebrow">SHARED AGREEMENT</span><h2>Edit the handoff</h2></div><button type="button" class="icon-button" id="close-dialog" aria-label="Close">${icon('close')}</button></div><p>From Aryan to Noel. Saving creates a new contract version; earlier runs keep their captured requirements.</p><label>Deliverable<input name="assignment" required maxlength="120" value="${esc(state.assignment)}"></label>${state.requirements.map((r, i) => `<fieldset><legend>0${i + 1} · ${esc(r.name)}</legend><label>Requirement<input name="name-${i}" required maxlength="1000" value="${esc(r.name)}"></label><label>Promise<textarea name="promise-${i}" required maxlength="1000">${esc(r.promise)}</textarea></label><label>How to verify<textarea name="verify-${i}" required maxlength="1000">${esc(r.verify)}</textarea></label></fieldset>`).join('')}<div class="editor-note">The API shape is fixed for this MVP. Custom requirement text is saved, but the demo still uses its predefined simulated outcomes.</div><button class="button primary" type="submit">Save contract v${version + 1}${icon('arrow')}</button></form>`;
  document.body.append(dialog); dialog.showModal();
  dialog.querySelector('#close-dialog').onclick = () => dialog.close();
  dialog.onclose = () => dialog.remove();
  dialog.querySelector('form').onsubmit = async event => { event.preventDefault(); if (state.contractVersion !== version) { toast('The contract changed in another view. Reopen the editor.'); return; } const data = new FormData(event.target); await request('contract', { contractVersion: version, assignment: data.get('assignment'), requirements: state.requirements.map((r, i) => ({ id: r.id, name: data.get('name-' + i), promise: data.get('promise-' + i), verify: data.get('verify-' + i) })) }); dialog.close(); };
}
function notifyMessage(message) {
  const peer = message.to === 'group' ? 'group' : message.from;
  if (readingConversation(peer)) return;
  const region = document.querySelector('#message-notifications');
  const card = document.createElement('article');
  card.className = 'message-notification';
  card.dataset.peer = peer;
  card.innerHTML = `<span class="avatar ${message.from.toLowerCase()}">${esc(message.from[0])}</span><div class="notification-copy"><strong>${esc(message.from)} ${peer === 'group' ? 'messaged the group' : 'messaged you'}</strong><p>${esc(message.kind === 'recommendation' ? message.title : message.text)}</p><button class="notification-open">View message ${icon('arrow')}</button></div><button class="notification-dismiss" aria-label="Dismiss message notification">${icon('close')}</button>`;
  card.querySelector('.notification-dismiss').onclick = () => card.remove();
  card.querySelector('.notification-open').onclick = () => {
    view = 'chat'; chatPeer = peer;
    region.querySelectorAll('.message-notification').forEach(item => { if (item.dataset.peer === peer) item.remove(); });
    render();
  };
  region.append(card);
  while (region.children.length > 3) region.firstElementChild.remove();
}
function acknowledgeVisibleConversation() {
  if (!readingConversation(chatPeer)) return;
  document.querySelectorAll('.message-notification').forEach(card => { if (card.dataset.peer === chatPeer) card.remove(); });
  if (unreadMessages(chatPeer)) request('chat-read', { owner: viewer, peer: chatPeer });
}
document.addEventListener('visibilitychange', acknowledgeVisibleConversation);
window.addEventListener('focus', acknowledgeVisibleConversation);
const events = new EventSource('/api/events');
events.onmessage = event => {
  connected = true;
  if (!acceptState(JSON.parse(event.data))) { render(); return; }
  const incoming = [];
  for (const message of state.messages || []) {
    if (messagesInitialized && !seenMessageIds.has(message.id) && message.from !== viewer && (message.to === viewer || message.to === 'group')) incoming.push(message);
    seenMessageIds.add(message.id);
  }
  messagesInitialized = true;
  render();
  incoming.forEach(notifyMessage);
};
events.onerror = () => { connected = false; render(); };
app.innerHTML = '<div class="loading">Connecting to your shared workspace...</div>';
