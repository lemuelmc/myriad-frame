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

  // Cover-flow screenshot gallery (iTunes-style 3D carousel).
  var track = document.getElementById('coverflow-track');
  var dotsWrap = document.getElementById('cf-dots');
  if (track && track.querySelectorAll('.cf-item').length > 0) {
    var items = Array.prototype.slice.call(track.querySelectorAll('.cf-item'));
    var count = items.length;
    // Default view: center on the "Resize & crop — custom size" screenshot.
    var active = 10;
    var cardW = 560;
    var cardH = 300;

    var D = {
      forward: 200,   // spacing along X
      sideways: 300,  // spacing toward the center
      up: 62,         // vertical lift for side cards
      tilt: 52,       // rotation (deg) for side cards
      depth: 425      // pull-back on Z for side cards
    };

    var dots = [];
    for (var i = 0; i < count; i++) {
      var d = document.createElement('button');
      d.type = 'button';
      d.className = 'cf-dot';
      d.setAttribute('role', 'tab');
      d.setAttribute('aria-label', 'Screenshot ' + (i + 1));
      d.addEventListener('click', function (idx) {
        return function () { go(idx); };
      }(i));
      dotsWrap.appendChild(d);
      dots.push(d);
    }

    var coverflow = track.closest('.coverflow');
    var navBtns = coverflow.querySelectorAll('.cf-nav');
    Array.prototype.slice.call(navBtns).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var dir = parseInt(btn.getAttribute('data-dir'), 10);
        go(active + dir);
      });
    });

    var render = function () {
      items.forEach(function (item, i) {
        var delta = i - active;
        var abs = Math.abs(delta);
        var onLeft = delta < 0;
        var x = abs === 0 ? 0 : (onLeft ? -D.sideways - Math.abs(delta) * D.forward : D.sideways + Math.abs(delta) * D.forward);
        var z = abs === 0 ? 0 : -D.depth;
        var rotY = delta === 0 ? 0 : (onLeft ? D.tilt : -D.tilt);
        var y = abs === 0 ? 0 : -D.up;
        var scale = abs === 0 ? 1 : 0.86;
        var opacity = abs === 0 ? 1 : 0.5;
        var filter = abs === 0 ? 'none' : 'brightness(0.75)';
        item.style.transform =
          'translate(calc(-50% + ' + x + 'px), calc(-50% + ' + y + 'px)) translateZ(' + z + 'px) rotateY(' + rotY + 'deg) scale(' + scale + ')';
        item.style.opacity = opacity;
        item.style.filter = filter;
        item.classList.toggle('interactive', abs === 0);
      });
      dots.forEach(function (d, i) {
        d.setAttribute('aria-selected', i === active ? 'true' : 'false');
      });
      var prevBtn = coverflow.querySelector('.cf-nav[data-dir="-1"]');
      var nextBtn = coverflow.querySelector('.cf-nav[data-dir="1"]');
      if (prevBtn) prevBtn.disabled = active <= 0;
      if (nextBtn) nextBtn.disabled = active >= count - 1;
    };

    var go = function (idx) {
      active = Math.min(count - 1, Math.max(0, idx));
      render();
    };

    // Pointer drag / swipe to rotate the carousel.
    var dragging = false;
    var dragX = 0;
    var committed = 0;

    var onDown = function (e) {
      dragging = true;
      committed = active;
      track.classList.add('dragging');
      dragX = (e.touches ? e.touches[0].clientX : e.clientX);
    };
    var onMove = function (e) {
      if (!dragging) return;
      var x = (e.touches ? e.touches[0].clientX : e.clientX);
      var dx = x - dragX;
      var threshold = cardW * 0.28;
      if (Math.abs(dx) >= threshold) {
        go(committed + (dx < 0 ? 1 : -1));
        dragX = x;
        committed = active;
      }
    };
    var onUp = function () {
      dragging = false;
      track.classList.remove('dragging');
    };

    track.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    track.addEventListener('touchstart', onDown, { passive: true });
    track.addEventListener('touchmove', onMove, { passive: true });
    track.addEventListener('touchend', onUp);

    // Keyboard control when the gallery is focused.
    track.tabIndex = 0;
    track.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft') { go(active - 1); e.preventDefault(); }
      else if (e.key === 'ArrowRight') { go(active + 1); e.preventDefault(); }
    });

    // Resize: re-sync nominal card dimensions so drag math stays accurate.
    function syncCardSize() {
      var sample = items[0];
      if (sample) {
        var r = sample.getBoundingClientRect();
        cardW = Math.max(200, r.width);
      }
    }
    window.addEventListener('resize', syncCardSize);

    render();
  }
})();
