<script setup lang="ts">
defineProps<{
  activePage: 'summary' | 'browser';
  isLoaded: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:activePage', page: 'summary' | 'browser'): void;
}>();
</script>

<template>
  <div class="sidebar-inner p-3 d-flex flex-column h-100">
    <div class="branding d-flex align-items-center mb-4 px-1">
      <i class="bi bi-activity fs-3 me-2 text-primary"></i>
      <span class="fw-bold fs-5">LRA</span>
    </div>

    <div class="flex-grow-1">
      <h6 class="mb-2 px-1 x-small text-uppercase fw-bold text-muted">Analysis</h6>
      <ul class="nav nav-pills flex-column gap-1">
        <li class="nav-item">
          <button 
            class="nav-link w-100 text-start d-flex align-items-center px-3 py-2"
            :class="{ active: activePage === 'summary' }"
            @click="emit('update:activePage', 'summary')"
          >
            <i class="bi bi-clipboard-data me-2"></i>
            Summary
          </button>
        </li>
        <li class="nav-item">
          <button 
            class="nav-link w-100 text-start d-flex align-items-center px-3 py-2"
            :class="{ 
              active: activePage === 'browser',
              disabled: !isLoaded
            }"
            @click="isLoaded && emit('update:activePage', 'browser')"
          >
            <i class="bi bi-search me-2"></i>
            Data Browser
          </button>
        </li>
      </ul>
    </div>

    <div class="mt-auto pt-3 border-top">
      <div class="d-flex align-items-center text-muted px-1">
        <i class="bi bi-github me-2"></i>
        <small>v0.1.0-alpha</small>
      </div>
    </div>
  </div>
</template>

<style scoped>
.x-small {
  font-size: 0.65rem;
  letter-spacing: 0.05rem;
}

.nav-link {
  color: var(--bs-body-color);
  border-radius: 8px;
  transition: all 0.2s;
  border: none;
  background: transparent;
}

.nav-link:hover:not(.active):not(.disabled) {
  background-color: var(--bs-tertiary-bg);
}

.nav-link.active {
  background-color: var(--bs-primary);
  color: white;
}

.nav-link.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
