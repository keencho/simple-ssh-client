<script lang="ts">
  import { toast } from "../../stores/toast.svelte";

  // seq를 keyed each의 키로 써서 같은 문구가 연속으로 떠도 노드가 새로
  // 만들어지고 진입 애니메이션이 다시 돈다.
  const entries = $derived(toast.message === null ? [] : [{ seq: toast.seq, text: toast.message }]);
</script>

<div class="toast-layer" aria-live="polite">
  {#each entries as e (e.seq)}
    <div class="toast">{e.text}</div>
  {/each}
</div>
