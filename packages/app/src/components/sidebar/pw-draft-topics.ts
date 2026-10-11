// PW build: "New chat in this topic". The sidebar opens a new chat draft and remembers which
// topic it was started from; when that draft becomes a chat, the chat is put in the topic.
// Kept by draft id, so only the draft opened from the topic is affected.

const topicByDraftId = new Map<string, string>();

export function rememberPwDraftTopic(draftId: string, topic: string): void {
  const name = topic.trim();
  if (draftId && name) topicByDraftId.set(draftId, name);
}

/** The topic a draft was started from, once: it is forgotten as it is read. */
export function takePwDraftTopic(draftId: string): string | null {
  const topic = topicByDraftId.get(draftId) ?? null;
  topicByDraftId.delete(draftId);
  return topic;
}
