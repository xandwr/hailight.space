<script lang="ts">
	import favicon from '$lib/assets/favicon.svg';
	import { invalidate } from '$app/navigation';
	import { onMount } from 'svelte';
	import { initAnalytics, track } from '$lib/analytics';
	import { beforeNavigate } from '$app/navigation';
	import '../app.css';

	let { data, children } = $props();

	onMount(() => {
		const { data: { subscription } } = data.supabase.auth.onAuthStateChange((_, newSession) => {
			if (newSession?.expires_at !== data.session?.expires_at) {
				invalidate('supabase:auth');
			}
		});

		if (data.user) {
			initAnalytics(data.supabase, data.user.id);
			track('page_view');
		}

		return () => subscription.unsubscribe();
	});

	beforeNavigate(({ to }) => {
		if (to && data.user) {
			track('page_view', { to: to.url.pathname });
		}
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{@render children()}
