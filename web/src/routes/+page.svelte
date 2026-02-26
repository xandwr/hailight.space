<script lang="ts">
	let { data } = $props();
	let isLoggedIn = $derived(!!data.user);

	let sourceCountDisplay = $derived(() => {
		const count = data.sourceCount;
		if (!count) return '3,800+';
		if (count >= 1000) return `${(Math.floor(count / 100) / 10).toFixed(1).replace(/\.0$/, '')}K+`;
		return `${count.toLocaleString()}+`;
	});
</script>

<svelte:head>
	<title>Hailight — the space between the stars</title>
	<meta name="description" content="A research platform that surfaces connections, contradictions, and gaps across sources — not just top results." />
</svelte:head>

<div class="min-h-screen bg-void text-text">
	<!-- Header -->
	<header class="px-6 py-5">
		<div class="mx-auto max-w-5xl flex items-center justify-between">
			<a href="/" class="group">
				<h1 class="text-2xl font-light tracking-wide text-bright">
					hai<span class="text-accent group-hover:text-accent-glow transition-colors">light</span>
				</h1>
			</a>
			{#if isLoggedIn}
				<a
					href="/search"
					class="rounded-md bg-accent px-4 py-2 text-sm font-medium text-bright
						hover:bg-accent-glow transition-colors"
				>
					Go to search
				</a>
			{:else}
				<a
					href="/auth"
					class="rounded-md border border-edge px-4 py-2 text-sm text-bright
						hover:border-accent/30 transition-colors"
				>
					Sign in
				</a>
			{/if}
		</div>
	</header>

	<!-- Hero -->
	<section class="px-6 pt-20 pb-16">
		<div class="mx-auto max-w-2xl text-center">
			<p class="text-lg text-text/80">Perplexity shows you the stars.</p>
			<p class="mt-2 text-3xl font-light text-bright sm:text-4xl">
				Hailight shows you the
				<span class="text-accent">space between</span> them.
			</p>
			<p class="mx-auto mt-6 max-w-lg text-sm leading-relaxed text-muted">
				A research platform that surfaces connections, contradictions, and gaps
				across sources — not just top results.
			</p>
			<div class="mt-10">
				{#if isLoggedIn}
					<a
						href="/search"
						class="inline-block rounded-lg bg-accent px-6 py-3 text-sm font-medium text-bright
							transition-all hover:bg-accent-glow hover:shadow-[0_0_30px_rgba(124,111,247,0.3)]"
					>
						Start searching
					</a>
				{:else}
					<a
						href="/auth"
						class="inline-block rounded-lg bg-accent px-6 py-3 text-sm font-medium text-bright
							transition-all hover:bg-accent-glow hover:shadow-[0_0_30px_rgba(124,111,247,0.3)]"
					>
						Get started
					</a>
				{/if}
			</div>
		</div>
	</section>


	<!-- Stats -->
	<section class="px-6 py-12">
		<div class="mx-auto flex max-w-2xl justify-center gap-12">
			<div class="text-center">
				<div class="text-2xl font-light text-bright">{sourceCountDisplay()}</div>
				<div class="mt-1 text-xs uppercase tracking-widest text-muted">Sources indexed</div>
			</div>
			<div class="text-center">
				<div class="text-2xl font-light text-bright">arXiv + OpenAlex</div>
				<div class="mt-1 text-xs uppercase tracking-widest text-muted">Growing daily</div>
			</div>
			<div class="text-center">
				<div class="text-2xl font-light text-bright">1,536</div>
				<div class="mt-1 text-xs uppercase tracking-widest text-muted">Embedding dimensions</div>
			</div>
		</div>
	</section>

	<!-- How it works -->
	<section class="px-6 py-16">
		<div class="mx-auto max-w-3xl">
			<h2 class="mb-8 text-center text-xs font-semibold uppercase tracking-widest text-muted">How it works</h2>
			<div class="grid gap-6 sm:grid-cols-3">
				<div class="rounded-xl border border-edge bg-deep p-6">
					<div class="mb-3 text-2xl text-accent">&#10022;</div>
					<h3 class="mb-2 text-base font-medium text-bright">Search</h3>
					<p class="text-sm leading-relaxed text-text/70">
						Ask a research question. We search academic and web sources simultaneously.
					</p>
				</div>
				<div class="rounded-xl border border-edge bg-deep p-6">
					<div class="mb-3 text-2xl text-accent">&harr;</div>
					<h3 class="mb-2 text-base font-medium text-bright">Connect</h3>
					<p class="text-sm leading-relaxed text-text/70">
						Every source is embedded and mapped against your research history. Connections, contradictions, and gaps surface automatically.
					</p>
				</div>
				<div class="rounded-xl border border-edge bg-deep p-6">
					<div class="mb-3 text-2xl text-accent">&#10038;</div>
					<h3 class="mb-2 text-base font-medium text-bright">Discover</h3>
					<p class="text-sm leading-relaxed text-text/70">
						Topics cluster organically. Cross-query echoes reveal patterns you didn't know to look for.
					</p>
				</div>
			</div>
		</div>
	</section>


	<!-- Footer -->
	<footer class="py-8 text-center text-xs text-muted/40">
		hailight.space
	</footer>
</div>
