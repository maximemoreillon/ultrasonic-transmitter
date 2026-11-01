<script lang="ts">
  import { PROFILES, type ProfileKey } from './modem.ts';

  let { value = $bindable(), disabled = false }: { value: ProfileKey; disabled?: boolean } = $props();
</script>

<label>
  Band
  <select bind:value {disabled}>
    {#each Object.entries(PROFILES) as [key, profile] (key)}
      <option value={key}>{profile.label}</option>
    {/each}
  </select>
</label>
