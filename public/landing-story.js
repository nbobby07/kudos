const announcement = document.querySelector('#story-announcement');
const tasks = document.querySelector('.demo-tasks');

function updateProgress() {
  const inputs = [...tasks.querySelectorAll('label:not([hidden]) input')];
  const completed = inputs.filter(input => input.checked).length;
  document.querySelector('.demo-progress span').style.width = `${completed / inputs.length * 100}%`;
  document.querySelector('.progress-copy').textContent = `${completed} of ${inputs.length} tasks complete`;
  document.querySelector('.person-line .status-chip').textContent = completed === inputs.length ? 'Complete' : 'In progress';
}

tasks.addEventListener('change', () => {
  updateProgress();
  announcement.textContent = document.querySelector('.progress-copy').textContent;
});

document.querySelector('#add-recommendation').addEventListener('click', event => {
  document.querySelector('.recommended-task').hidden = false;
  document.querySelectorAll('.snapshot-recommendation').forEach(item => { item.hidden = false; });
  const button = event.currentTarget;
  button.textContent = "Added to Aryan's tasks";
  button.disabled = true;
  updateProgress();
  announcement.textContent = "Noel's recommendation was added to the example checklist and handoff previews. Your workspace has not changed.";
});

document.querySelector('#send-example').addEventListener('click', event => {
  document.querySelector('.incoming-item').open = true;
  document.querySelector('#received-note').textContent = 'Example handoff received. Context included. Your turn, Noel.';
  event.currentTarget.textContent = 'Example handoff received by Noel';
  event.currentTarget.disabled = true;
  announcement.textContent = "Example handoff opened in Noel's Incoming. No real delivery was sent.";
  const summary = document.querySelector('.incoming-item summary');
  summary.focus({ preventScroll: true });
  document.querySelector('#receive').scrollIntoView({ block: 'start' });
});

// Scroll only highlights chapters; it never overwrites a visitor's demo choices.
if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      entry.target.classList.toggle('is-current', entry.isIntersecting);
      const link = document.querySelector(`.chapter-nav a[href="#${entry.target.id}"]`);
      if (link) {
        if (entry.isIntersecting) link.setAttribute('aria-current', 'step');
        else link.removeAttribute('aria-current');
      }
    });
  }, { rootMargin: '-20% 0px -35% 0px' });
  document.querySelectorAll('.story-chapter, .closing-section').forEach(section => observer.observe(section));
}
