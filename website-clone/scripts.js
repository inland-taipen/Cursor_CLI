document.addEventListener('DOMContentLoaded', function() {
  // Hamburger toggle
  const navToggle = document.querySelector('.nav-toggle');
  const navMenu = document.querySelector('.nav-menu');

  navToggle.addEventListener('click', function() {
    navMenu.classList.toggle('active');
  });

  // Smooth scroll
  const links = document.querySelectorAll('a[href^="#"]');

  links.forEach(function(link) {
    link.addEventListener('click', function(event) {
      event.preventDefault();

      const href = link.getAttribute('href');
      const section = document.querySelector(href);

      section.scrollIntoView({
        behavior: 'smooth'
      });
    });
  });
});