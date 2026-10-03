import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { createContext, useContext } from 'react';
import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
  useExternalMessageConverter,
  useExternalStoreRuntime,
} from '@assistant-ui/react';
const TaskActions = createContext(null);

function TextPart({ text }) {
  return <p>{text}</p>;
}

function TeammateMessage() {
  const message = useAuiState(state => state.message);
  const { sender, kind, title, own, messageId, taskEntry } = message.metadata.custom;
  const { onAddTask, onRemove, onOpenPlan } = useContext(TaskActions);
  return (
    <MessagePrimitive.Root className={`chat-message ${own ? 'own' : ''}`} data-author={sender}>
      <div className="message-meta">
        <strong>{sender}</strong>
        <time dateTime={message.createdAt.toISOString()}>
          {message.createdAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </time>
      </div>
      <div className="message-bubble">
        {kind === 'recommendation' && <><span className="chat-source">Recommended by {sender}</span><h3>{title}</h3></>}
        <MessagePrimitive.Parts components={{ Text: TextPart }} />
      </div>
      {kind === 'recommendation' && !own && <div className="message-task-actions">
        {taskEntry ? <>
          <span>{taskEntry.addedBy === 'auto' ? 'Automatically added to your to-do list' : 'Added to your to-do list'}</span>
          <button className="message-task-button" onClick={onOpenPlan}>View task</button>
          {taskEntry.addedBy === 'auto' && <button className="message-task-undo" onClick={() => onRemove(taskEntry.id)}>Undo</button>}
        </> : <button className="message-task-button" onClick={() => onAddTask(messageId)}>+ Add to your to-do list</button>}
      </div>}
    </MessagePrimitive.Root>
  );
}

function SharedThread({ messages, viewer, peer, onNew, tasks, onAddTask, onRemove, onOpenPlan }) {
  const converted = useExternalMessageConverter({
    messages,
    isRunning: false,
    joinStrategy: 'none',
    callback: message => ({
      id: message.id,
      // Runtime roles control bubble alignment, not authorship or AI identity.
      role: message.from === viewer ? 'user' : 'assistant',
      content: [{ type: 'text', text: message.text }],
      createdAt: new Date(message.sentAt),
      metadata: { custom: { sender: message.from, kind: message.kind, title: message.title, own: message.from === viewer, messageId: message.id, taskEntry: tasks.find(entry => entry.messageId === message.id) } },
    }),
  });
  const runtime = useExternalStoreRuntime({ messages: converted, onNew });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TaskActions.Provider value={{ onAddTask, onRemove, onOpenPlan }}>
      <ThreadPrimitive.Root data-assistant-ui="thread">
        {messages.length ? <ThreadPrimitive.Messages components={{ UserMessage: TeammateMessage, AssistantMessage: TeammateMessage }} /> : (
          <div className="chat-empty">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M21 11a8 8 0 0 1-8 8H8l-5 3V7a5 5 0 0 1 5-5h5a8 8 0 0 1 8 9Z" /></svg>
            <h3>A quick conversation can unblock good work.</h3>
            <p>Message {peer}, or recommend a task so it won't get lost in the conversation.</p>
          </div>
        )}
      </ThreadPrimitive.Root>
      </TaskActions.Provider>
    </AssistantRuntimeProvider>
  );
}

export function mountAssistantThread(element, props) {
  const root = createRoot(element);
  flushSync(() => root.render(<SharedThread {...props} />));
  return () => root.unmount();
}

function ReviewMessage() {
  const message = useAuiState(state => state.message);
  return <MessagePrimitive.Root className={`chat-message ${message.role === 'user' ? 'own' : ''}`}>
    <div className="message-meta"><strong>{message.role === 'user' ? 'You' : 'Kudos review assistant'}</strong></div>
    <div className="message-bubble"><MessagePrimitive.Parts components={{ Text: TextPart }} /></div>
  </MessagePrimitive.Root>;
}

function ReviewThread({ messages, onNew }) {
  const converted = useExternalMessageConverter({
    messages, isRunning: false, joinStrategy: 'none',
    callback: message => ({ id: message.id, role: message.role, content: [{ type: 'text', text: message.text }], createdAt: new Date(message.sentAt) }),
  });
  const runtime = useExternalStoreRuntime({ messages: converted, onNew });
  return <AssistantRuntimeProvider runtime={runtime}>
    <ThreadPrimitive.Root data-assistant-ui="pr-review-thread">
      <ThreadPrimitive.Messages components={{ UserMessage: ReviewMessage, AssistantMessage: ReviewMessage }} />
    </ThreadPrimitive.Root>
  </AssistantRuntimeProvider>;
}

export function mountReviewThread(element, props) {
  const root = createRoot(element);
  flushSync(() => root.render(<ReviewThread {...props} />));
  return () => root.unmount();
}
