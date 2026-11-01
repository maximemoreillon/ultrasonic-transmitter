<script lang="ts">
  import Transmitter from './Transmitter.svelte';
  import Receiver from './Receiver.svelte';

  let tab: 'tx' | 'rx' = $state('tx');
</script>

<header>
  <h1>Ultrasonic transmitter</h1>
  <div class="tabs" role="tablist">
    <button role="tab" aria-selected={tab === 'tx'} onclick={() => (tab = 'tx')}>Transmit</button>
    <button role="tab" aria-selected={tab === 'rx'} onclick={() => (tab = 'rx')}>Receive</button>
  </div>
</header>

<!-- Both panels stay mounted (only hidden) so the receiver keeps listening while the Transmit tab is open. -->
<main>
  <section class="panel" hidden={tab !== 'tx'}><Transmitter /></section>
  <section class="panel" hidden={tab !== 'rx'}><Receiver /></section>
</main>
