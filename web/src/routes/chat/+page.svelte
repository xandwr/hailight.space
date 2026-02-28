<script lang="ts">
	import { goto } from '$app/navigation';
	import Header from '$lib/components/Header.svelte';
	import { track } from '$lib/analytics';

	let { data } = $props();

	interface Conversation {
		id: string;
		title: string;
		updated_at: string;
		messages: any[];
	}

	let conversations = $state<Conversation[]>([]);
	let loading = $state(true);

	$effect(() => {
		data.supabase
			.from('conversations')
			.select('id, title, updated_at, messages')
			.order('updated_at', { ascending: false })
			.then(({ data: convs, error }: any) => {
				if (!error && convs) {
					conversations = convs;
				}
				loading = false;
			});
	});

	function newChat() {
		track('chat_new');
		goto('/chat/new');
	}

	function openChat(id: string) {
		track('chat_open', { conversation_id: id });
		goto(`/chat/${id}`);
	}

	function timeAgo(dateStr: string): string {
		const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
		if (seconds < 60) return 'just now';
		if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
		if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
		return `${Math.floor(seconds / 86400)}d ago`;
	}

	function lastMessage(conv: Conversation): string {
		const msgs = conv.messages ?? [];
		if (msgs.length === 0) return 'No messages yet';
		const last = msgs[msgs.length - 1];
		const content = last.content ?? '';
		return content.length > 100 ? content.slice(0, 97) + '...' : content;
	}
</script>

<div class="min-h-screen bg-void text-text">
	<Header user={data.user} supabase={data.supabase} />

	<main class="mx-auto max-w-3xl px-6 py-12">
		<div class="flex items-center justify-between mb-8">
			<h2 class="text-xl font-light text-bright">Conversations</h2>
			<button
				onclick={newChat}
				class="rounded-md bg-accent px-4 py-2 text-sm font-medium text-bright
					transition-colors hover:bg-accent-glow"
			>
				New chat
			</button>
		</div>

		{#if loading}
			<div class="flex flex-col items-center gap-4 py-16 text-muted">
				<div class="h-6 w-6 animate-spin rounded-full border-2 border-edge border-t-accent"></div>
			</div>
		{:else if conversations.length === 0}
			<div class="flex flex-col items-center py-24 text-center">
				<p class="text-lg text-muted">No conversations yet</p>
				<p class="mt-2 text-sm text-muted/70">
					Start a new chat to discuss your research with an AI that knows your topics and sources.
				</p>
				<button
					onclick={newChat}
					class="mt-6 rounded-md bg-accent px-6 py-3 text-sm font-medium text-bright
						transition-colors hover:bg-accent-glow"
				>
					Start chatting
				</button>
			</div>
		{:else}
			<div class="space-y-2">
				{#each conversations as conv}
					<button
						onclick={() => openChat(conv.id)}
						class="w-full rounded-lg border border-edge bg-deep p-4 text-left
							transition-colors hover:border-accent/30 hover:bg-surface"
					>
						<div class="flex items-start justify-between gap-4">
							<div class="min-w-0 flex-1">
								<h3 class="text-sm font-medium text-bright truncate">{conv.title}</h3>
								<p class="mt-1 text-xs text-muted truncate">{lastMessage(conv)}</p>
							</div>
							<div class="shrink-0 text-right">
								<span class="text-xs text-muted">{timeAgo(conv.updated_at)}</span>
								<p class="mt-1 text-xs text-muted/60">
									{(conv.messages ?? []).length} msgs
								</p>
							</div>
						</div>
					</button>
				{/each}
			</div>
		{/if}
	</main>
</div>
