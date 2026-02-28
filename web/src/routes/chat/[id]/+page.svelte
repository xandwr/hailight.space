<script lang="ts">
	import { PUBLIC_SUPABASE_PROJECT_URL } from '$env/static/public';
	import { page } from '$app/stores';
	import Header from '$lib/components/Header.svelte';
	import { track } from '$lib/analytics';

	let { data } = $props();

	interface ChatMessage {
		role: 'user' | 'assistant';
		content: string;
		ts: string;
	}

	let messages = $state<ChatMessage[]>([]);
	let input = $state('');
	let streaming = $state(false);
	let streamingContent = $state('');
	let error = $state<string | null>(null);
	let conversationId = $state('');
	let conversationTitle = $state('');
	let messagesEl: HTMLDivElement;

	// Load conversation on mount
	$effect(() => {
		const id = $page.params.id;
		if (id === 'new') {
			conversationId = '';
			messages = [];
			conversationTitle = 'New conversation';
			return;
		}

		conversationId = id;
		data.supabase
			.from('conversations')
			.select('id, title, messages')
			.eq('id', id)
			.single()
			.then(({ data: conv, error: err }: any) => {
				if (err || !conv) {
					error = 'Conversation not found';
					return;
				}
				messages = conv.messages ?? [];
				conversationTitle = conv.title;
			});
	});

	// Auto-scroll on new messages
	$effect(() => {
		if (messages.length || streamingContent) {
			requestAnimationFrame(() => {
				messagesEl?.scrollTo({ top: messagesEl.scrollHeight, behavior: 'smooth' });
			});
		}
	});

	async function send() {
		if (!input.trim() || streaming) return;

		const messageText = input.trim();
		const userMessage: ChatMessage = {
			role: 'user',
			content: messageText,
			ts: new Date().toISOString(),
		};
		messages = [...messages, userMessage];
		input = '';
		streaming = true;
		streamingContent = '';
		error = null;

		track('chat_send', { conversation_id: conversationId || 'new', message_length: messageText.length });

		try {
			const resp = await fetch(`${PUBLIC_SUPABASE_PROJECT_URL}/functions/v1/chat`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${data.session?.access_token}`,
				},
				body: JSON.stringify({
					message: messageText,
					conversation_id: conversationId || undefined,
				}),
			});

			if (!resp.ok) {
				const errData = await resp.json();
				throw new Error(errData.error?.message || `Request failed: ${resp.status}`);
			}

			// Capture conversation ID for new conversations
			const newConvId = resp.headers.get('x-conversation-id');
			if (newConvId && !conversationId) {
				conversationId = newConvId;
				history.replaceState({}, '', `/chat/${newConvId}`);
			}

			// Read SSE stream
			const reader = resp.body!.getReader();
			const decoder = new TextDecoder();

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				const chunk = decoder.decode(value, { stream: true });
				const lines = chunk.split('\n');

				for (const line of lines) {
					if (!line.startsWith('data: ')) continue;
					const payload = line.slice(6).trim();
					if (payload === '[DONE]') continue;
					try {
						const parsed = JSON.parse(payload);
						const delta = parsed.choices?.[0]?.delta?.content;
						if (delta) streamingContent += delta;
					} catch {
						/* skip */
					}
				}
			}

			// Finalize
			messages = [
				...messages,
				{ role: 'assistant', content: streamingContent, ts: new Date().toISOString() },
			];
			track('chat_stream_complete', {
				conversation_id: conversationId,
				response_length: streamingContent.length,
			});
			streamingContent = '';
		} catch (e: any) {
			error = e.message;
			track('chat_error', { error: e.message, conversation_id: conversationId });
		} finally {
			streaming = false;
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			send();
		}
	}
</script>

<div class="flex h-screen flex-col bg-void text-text">
	<Header user={data.user} supabase={data.supabase} />

	<main class="flex flex-1 flex-col overflow-hidden">
		<!-- Messages -->
		<div bind:this={messagesEl} class="flex-1 overflow-y-auto">
			<div class="mx-auto max-w-3xl space-y-4 px-6 py-8">
				{#if messages.length === 0 && !streaming}
					<div class="flex flex-col items-center justify-center py-24 text-center">
						<h2 class="text-2xl font-light text-bright">
							Ask about your research
						</h2>
						<p class="mt-3 max-w-md text-sm text-muted">
							Chat with an assistant that knows your topics, sources, and research trajectory.
						</p>
					</div>
				{/if}

				{#each messages as msg}
					<div class="flex {msg.role === 'user' ? 'justify-end' : 'justify-start'}">
						<div
							class="max-w-[85%] rounded-lg px-4 py-3 text-sm leading-relaxed
								{msg.role === 'user'
								? 'bg-accent/10 text-bright border border-accent/20'
								: 'bg-deep text-text border border-edge'}"
						>
							{#if msg.role === 'assistant'}
								{@html renderMarkdown(msg.content)}
							{:else}
								<p class="whitespace-pre-wrap">{msg.content}</p>
							{/if}
						</div>
					</div>
				{/each}

				{#if streaming && streamingContent}
					<div class="flex justify-start">
						<div
							class="max-w-[85%] rounded-lg border border-edge bg-deep px-4 py-3 text-sm leading-relaxed text-text"
						>
							{@html renderMarkdown(streamingContent)}<span
								class="inline-block h-4 w-0.5 animate-pulse bg-accent align-text-bottom"
							></span>
						</div>
					</div>
				{:else if streaming}
					<div class="flex justify-start">
						<div
							class="rounded-lg border border-edge bg-deep px-4 py-3 text-sm text-muted"
						>
							<div class="flex items-center gap-2">
								<div
									class="h-4 w-4 animate-spin rounded-full border-2 border-edge border-t-accent"
								></div>
								Thinking...
							</div>
						</div>
					</div>
				{/if}

				{#if error}
					<div
						class="rounded-lg border border-contradict/30 bg-contradict/5 px-4 py-3 text-sm text-contradict"
					>
						{error}
					</div>
				{/if}
			</div>
		</div>

		<!-- Input -->
		<div class="border-t border-edge/50 bg-void px-6 pb-6 pt-4">
			<div class="mx-auto max-w-3xl">
				<div class="relative">
					<textarea
						bind:value={input}
						onkeydown={handleKeydown}
						placeholder="Ask about your research..."
						disabled={streaming}
						rows="1"
						style="field-sizing: content; max-height: 150px;"
						class="w-full resize-none rounded-lg border border-edge bg-surface px-5 py-4 pr-24 text-base text-bright
							placeholder-muted outline-none transition-colors overflow-y-auto
							focus:border-accent/50 focus:ring-1 focus:ring-accent/25
							disabled:opacity-50"
					></textarea>
					<button
						onclick={send}
						disabled={streaming || !input.trim()}
						class="absolute bottom-3 right-3 rounded-md bg-accent px-4 py-2
							text-sm font-medium text-bright transition-opacity
							hover:bg-accent-glow disabled:opacity-30"
					>
						{streaming ? '...' : 'Send'}
					</button>
				</div>
			</div>
		</div>
	</main>
</div>

<script lang="ts" module>
	/**
	 * Minimal markdown renderer — handles bold, italic, code, links, headers, lists.
	 * No external dependencies.
	 */
	function renderMarkdown(text: string): string {
		return text
			// Code blocks
			.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre class="my-2 rounded bg-void p-3 text-xs overflow-x-auto border border-edge"><code>$2</code></pre>')
			// Inline code
			.replace(/`([^`]+)`/g, '<code class="rounded bg-void px-1.5 py-0.5 text-xs border border-edge">$1</code>')
			// Headers
			.replace(/^### (.+)$/gm, '<h3 class="mt-3 mb-1 text-sm font-semibold text-bright">$1</h3>')
			.replace(/^## (.+)$/gm, '<h2 class="mt-3 mb-1 text-base font-semibold text-bright">$1</h2>')
			// Bold
			.replace(/\*\*([^*]+)\*\*/g, '<strong class="text-bright">$1</strong>')
			// Italic
			.replace(/\*([^*]+)\*/g, '<em>$1</em>')
			// Links
			.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" class="text-accent hover:text-accent-glow underline">$1</a>')
			// Unordered lists
			.replace(/^- (.+)$/gm, '<li class="ml-4 list-disc">$1</li>')
			// Numbered lists
			.replace(/^\d+\. (.+)$/gm, '<li class="ml-4 list-decimal">$1</li>')
			// Paragraphs (double newline)
			.replace(/\n\n/g, '</p><p class="mt-2">')
			// Single newlines
			.replace(/\n/g, '<br>')
			// Wrap in paragraph
			.replace(/^/, '<p>')
			.replace(/$/, '</p>');
	}
</script>
