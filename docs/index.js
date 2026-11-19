(function () {
  const { findByProps, findByStoreName } = vendetta.metro;
  const { React, ReactNative, FluxDispatcher } = vendetta.metro.common;
  const { storage } = vendetta.plugin;
  const { useProxy } = vendetta.storage;
  const { Forms } = vendetta.ui.components;
  const { FormSection, FormInput, FormSwitchRow, FormText } = Forms;
  const { ScrollView } = ReactNative;

  const ChannelStore = findByStoreName("ChannelStore");
  const UserStore = findByStoreName("UserStore");
  const RestAPI = findByProps("getAPIBaseURL", "get");

  const DRIVE_RE = /https?:\/\/(?:drive|docs|drive\.usercontent)\.google\.com\/\S+/i;
  const MENTION_RE = /<@[!&]?\d+>|@everyone|@here/;

  const handled = new Set();
  const timers = new Set();

  function ensureDefaults() {
    if (!Array.isArray(storage.rules) || storage.rules.length !== 2) {
      storage.rules = [
        { enabled: true, channelId: "", reply: "" },
        { enabled: true, channelId: "", reply: "" },
      ];
    }
    storage.delayMs ??= 1000;
    storage.includeFirstPost ??= true;
    storage.replyToMessage ??= false;
  }

  function isMatch(msg) {
    // normal message only (type 0), not a reply/forward
    if (msg.type !== 0) return false;
    if (msg.message_reference || msg.referenced_message) return false;

    // no pings of any kind
    if (msg.mention_everyone) return false;
    if (msg.mentions && msg.mentions.length) return false;
    if (msg.mention_roles && msg.mention_roles.length) return false;
    const content = msg.content || "";
    if (MENTION_RE.test(content)) return false;

    // attachment or Google Drive link
    const hasAttachment = msg.attachments && msg.attachments.length > 0;
    return hasAttachment || DRIVE_RE.test(content);
  }

  function onMessage({ message, optimistic }) {
    try {
      if (optimistic || !message || !message.id || !message.channel_id) return;
      if (handled.has(message.id)) return;

      const me = UserStore.getCurrentUser();
      if (!me || !message.author || message.author.id === me.id || message.author.bot) return;

      const channel = ChannelStore.getChannel(message.channel_id);
      if (!channel || !channel.parent_id) return; // must be a thread

      const rule = storage.rules.find(
        (r) => r.enabled && r.channelId && r.reply && r.channelId === channel.parent_id
      );
      if (!rule) return;

      // forum posts: the opening message shares its id with the thread
      if (!storage.includeFirstPost && message.id === message.channel_id) return;

      if (!isMatch(message)) return;

      handled.add(message.id);
      if (handled.size > 500) handled.delete(handled.values().next().value);

      const send = () => {
        const body = {
          content: rule.reply,
          nonce: String((Date.now() - 1420070400000) * 4194304),
        };
        if (storage.replyToMessage) {
          body.message_reference = {
            channel_id: message.channel_id,
            message_id: message.id,
          };
        }
        RestAPI.post({ url: `/channels/${message.channel_id}/messages`, body }).catch(() => {});
      };

      const delay = Math.max(0, Number(storage.delayMs) || 0);
      if (delay === 0) return send();
      const t = setTimeout(() => {
        timers.delete(t);
        send();
      }, delay);
      timers.add(t);
    } catch (e) {
      console.log("[ThreadFileReply]", e);
    }
  }

  // Switch that keeps its own state so it always flips on tap,
  // and writes through to storage.
  function Toggle({ label, get, set }) {
    const [value, setValue] = React.useState(!!get());
    return React.createElement(FormSwitchRow, {
      label,
      value,
      onValueChange: (v) => {
        setValue(v);
        set(v);
      },
    });
  }

  // Replace the whole rules array so the change is always saved.
  function updateRule(i, patch) {
    storage.rules = storage.rules.map((r, j) => ({
      enabled: r.enabled,
      channelId: r.channelId,
      reply: r.reply,
      ...(j === i ? patch : {}),
    }));
  }

  function Settings() {
    useProxy(storage);
    ensureDefaults();
    const h = React.createElement;

    const ruleSections = storage.rules.map((rule, i) =>
      h(
        FormSection,
        { key: i, title: `Server ${i + 1}`, titleStyleType: "no_border" },
        h(Toggle, {
          label: "Enabled",
          get: () => storage.rules[i].enabled,
          set: (v) => updateRule(i, { enabled: v }),
        }),
        h(FormInput, {
          title: "Forum/parent channel ID",
          placeholder: "Channel ID whose threads are watched",
          value: rule.channelId,
          onChange: (v) => updateRule(i, { channelId: v.trim() }),
          keyboardType: "numeric",
        }),
        h(FormInput, {
          title: "Reply for this server",
          placeholder: "Message sent in the thread",
          value: rule.reply,
          onChange: (v) => updateRule(i, { reply: v }),
          multiline: true,
        })
      )
    );

    return h(
      ScrollView,
      null,
      ...ruleSections,
      h(
        FormSection,
        { title: "General" },
        h(FormInput, {
          title: "Delay before replying (ms)",
          value: String(storage.delayMs),
          onChange: (v) => (storage.delayMs = Number(v.replace(/\D/g, "")) || 0),
          keyboardType: "numeric",
        }),
        h(Toggle, {
          label: "Include the thread's first post",
          get: () => storage.includeFirstPost,
          set: (v) => (storage.includeFirstPost = v),
        }),
        h(Toggle, {
          label: "Send as a reply to the message",
          get: () => storage.replyToMessage,
          set: (v) => (storage.replyToMessage = v),
        }),
        h(
          FormText,
          { style: { padding: 16 } },
          "Replies only to normal messages (not replies, no pings) that have an attachment or a Google Drive link, inside threads of the configured channel."
        )
      )
    );
  }

  return {
    onLoad() {
      ensureDefaults();
      FluxDispatcher.subscribe("MESSAGE_CREATE", onMessage);
    },
    onUnload() {
      FluxDispatcher.unsubscribe("MESSAGE_CREATE", onMessage);
      timers.forEach(clearTimeout);
      timers.clear();
      handled.clear();
    },
    settings: Settings,
  };
})()
