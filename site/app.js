/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

/* Myriad Frame — static landing page interactivity. */

(function () {
  'use strict';

  // Current year in the footer.
  var yearEl = document.getElementById('year');
  if (yearEl) {
    yearEl.textContent = new Date().getFullYear();
  }

  // Reveal-on-scroll for .reveal elements.
  var revealEls = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add('visible');
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12 }
    );
    revealEls.forEach(function (el) {
      io.observe(el);
    });
  } else {
    // Fallback: show everything immediately.
    revealEls.forEach(function (el) {
      el.classList.add('visible');
    });
  }

  // Mobile nav: hamburger toggle for the collapsed links panel (≤720px).
  var nav = document.querySelector('nav');
  var navToggle = document.querySelector('nav .nav-toggle');
  if (nav && navToggle) {
    var setNavOpen = function (open) {
      nav.classList.toggle('open', open);
      navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    navToggle.addEventListener('click', function () {
      setNavOpen(!nav.classList.contains('open'));
    });
    // Close after choosing a link.
    var navLinks = nav.querySelectorAll('.links a');
    navLinks.forEach(function (link) {
      link.addEventListener('click', function () {
        setNavOpen(false);
      });
    });
    // Close on Escape.
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && nav.classList.contains('open')) {
        setNavOpen(false);
        navToggle.focus();
      }
    });
    // Reset state when the viewport grows past the breakpoint.
    var mq = window.matchMedia('(min-width: 721px)');
    var onMq = function (e) {
      if (e.matches) setNavOpen(false);
    };
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onMq);
    } else if (typeof mq.addListener === 'function') {
      mq.addListener(onMq);
    }
  }
})();
