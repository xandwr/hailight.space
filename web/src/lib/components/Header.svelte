<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';

	let { user, supabase } = $props();

	let currentPath = $derived($page.url.pathname);

	async function logout() {
		await supabase.auth.signOut();
		goto('/auth');
	}
</script>

<header class="border-b border-edge/50 px-6 py-4">
	<div class="mx-auto max-w-5xl flex items-center justify-between">
		<div class="flex items-center gap-8">
			<a href="/" class="group">
				<h1 class="text-2xl font-light tracking-wide text-bright">
					hai<span class="text-accent group-hover:text-accent-glow transition-colors">light</span>
				</h1>
			</a>
			<nav class="flex items-center gap-1">
				<a
					href="/"
					class="rounded-md px-3 py-1.5 text-sm transition-colors
						{currentPath === '/' ? 'text-bright bg-surface' : 'text-muted hover:text-text'}"
				>
					Search
				</a>
				<a
					href="/dashboard"
					class="rounded-md px-3 py-1.5 text-sm transition-colors
						{currentPath === '/dashboard' ? 'text-bright bg-surface' : 'text-muted hover:text-text'}"
				>
					Research Spaces
				</a>
				<a
					href="/dashboard/graph"
					class="rounded-md px-3 py-1.5 text-sm transition-colors
						{currentPath === '/dashboard/graph' ? 'text-bright bg-surface' : 'text-muted hover:text-text'}"
				>
					Graph
				</a>
			</nav>
		</div>
		<div class="flex items-center gap-4">
			<span class="text-xs text-muted">{user?.email}</span>
			<button
				onclick={logout}
				class="rounded-md border border-edge px-3 py-1.5 text-xs text-muted
					transition-colors hover:border-edge hover:text-text"
			>
				Log out
			</button>
		</div>
	</div>
</header>
