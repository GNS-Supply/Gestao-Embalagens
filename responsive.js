/* ==========================================================================
   RESPONSIVE MENU
   CONTROLE DE EMBALAGENS — MAGIUS + YMS

   Cria uma navegação mobile a partir dos mesmos .nav-tab existentes
   no index.html.

   Não duplica a lógica de navegação.
   Os botões continuam chamando switchTab() normalmente.
   ========================================================================== */

(function () {
  'use strict';

  const MOBILE_BREAKPOINT = 767;

  let mobileButton = null;
  let mobileDrawer = null;
  let mobileBackdrop = null;

  function isMobile() {
    return window.innerWidth <= MOBILE_BREAKPOINT;
  }

  function getNavTabs() {
    return Array.from(document.querySelectorAll('.nav-tabs .nav-tab'));
  }

  function getCurrentUserName() {
    const el = document.getElementById('topbar-name');

    if (!el) {
      return '';
    }

    return (el.textContent || '').trim();
  }

  function getCurrentUserRole() {
    const el = document.getElementById('topbar-role');

    if (!el) {
      return '';
    }

    return (el.textContent || '').trim();
  }

  function getBrandName() {
    const el = document.querySelector('.topbar-brand');

    if (!el) {
      return 'Magius · Embalagens';
    }

    return (el.textContent || '').trim();
  }

  function getButtonIcon(button) {
    const text = (button.textContent || '').trim();

    const match = text.match(
      /^(\p{Emoji_Presentation}|\p{Extended_Pictographic}|[＋🔍🏢📦📉📋🧮⚙️]+)/u
    );

    return match ? match[0] : '•';
  }

  function getButtonLabel(button) {
    const text = (button.textContent || '').trim();

    const icon = getButtonIcon(button);

    if (icon && text.startsWith(icon)) {
      return text.slice(icon.length).trim();
    }

    return text;
  }

  function createMobileButton() {
    if (mobileButton) {
      return;
    }

    const topbar = document.querySelector('.topbar');

    if (!topbar) {
      return;
    }

    mobileButton = document.createElement('button');

    mobileButton.type = 'button';
    mobileButton.className = 'mobile-menu-button';

    mobileButton.setAttribute(
      'aria-label',
      'Abrir menu de navegação'
    );

    mobileButton.setAttribute(
      'aria-controls',
      'mobile-menu-drawer'
    );

    mobileButton.setAttribute(
      'aria-expanded',
      'false'
    );

    const icon = document.createElement('span');

    icon.className = 'mobile-menu-icon';

    const middleLine = document.createElement('span');

    icon.appendChild(middleLine);
    mobileButton.appendChild(icon);

    mobileButton.addEventListener('click', function () {
      if (document.body.classList.contains('mobile-menu-open')) {
        closeMobileMenu();
      } else {
        openMobileMenu();
      }
    });

    /*
     * Coloca o botão antes da marca.
     */
    topbar.insertBefore(mobileButton, topbar.firstElementChild);
  }

  function createMobileStructure() {
    if (mobileDrawer) {
      return;
    }

    mobileBackdrop = document.createElement('div');

    mobileBackdrop.className = 'mobile-menu-backdrop';

    mobileBackdrop.setAttribute(
      'aria-hidden',
      'true'
    );

    mobileBackdrop.addEventListener(
      'click',
      closeMobileMenu
    );

    document.body.appendChild(mobileBackdrop);


    mobileDrawer = document.createElement('aside');

    mobileDrawer.id = 'mobile-menu-drawer';
    mobileDrawer.className = 'mobile-menu-drawer';

    mobileDrawer.setAttribute(
      'aria-label',
      'Menu principal'
    );

    mobileDrawer.setAttribute(
      'aria-hidden',
      'true'
    );


    /*
     * Cabeçalho
     */

    const header = document.createElement('div');

    header.className = 'mobile-menu-header';


    const titleWrap = document.createElement('div');

    titleWrap.className = 'mobile-menu-title-wrap';


    const title = document.createElement('div');

    title.className = 'mobile-menu-title';
    title.textContent = getBrandName();


    const user = document.createElement('div');

    user.className = 'mobile-menu-user';

    const userName = getCurrentUserName();
    const userRole = getCurrentUserRole();

    if (userName && userRole) {
      user.textContent = `${userName} · ${userRole}`;
    } else if (userName) {
      user.textContent = userName;
    } else {
      user.textContent = '';
    }


    titleWrap.appendChild(title);
    titleWrap.appendChild(user);


    const closeButton = document.createElement('button');

    closeButton.type = 'button';
    closeButton.className = 'mobile-menu-close';
    closeButton.setAttribute(
      'aria-label',
      'Fechar menu'
    );
    closeButton.textContent = '×';

    closeButton.addEventListener(
      'click',
      closeMobileMenu
    );


    header.appendChild(titleWrap);
    header.appendChild(closeButton);


    /*
     * Navegação
     */

    const nav = document.createElement('nav');

    nav.className = 'mobile-menu-nav';

    nav.setAttribute(
      'aria-label',
      'Navegação principal'
    );


    /*
     * Rodapé
     */

    const footer = document.createElement('div');

    footer.className = 'mobile-menu-footer';


    const footerUser = document.createElement('div');

    footerUser.className = 'mobile-menu-footer-user';

    const footerUserText = document.createElement('div');

    const currentName = getCurrentUserName();

    if (currentName) {
      footerUserText.textContent =
        `Usuário: ${currentName}`;
    } else {
      footerUserText.textContent =
        'Controle de Embalagens';
    }

    footerUser.appendChild(
      footerUserText
    );


    const logoutButton = document.createElement('button');

    logoutButton.type = 'button';
    logoutButton.className =
      'btn btn-secondary mobile-menu-logout';

    logoutButton.textContent =
      '↪ Sair';

    logoutButton.addEventListener(
      'click',
      function () {
        closeMobileMenu();

        if (typeof window.doLogout === 'function') {
          window.doLogout();
        }
      }
    );


    footer.appendChild(footerUser);
    footer.appendChild(logoutButton);


    mobileDrawer.appendChild(header);
    mobileDrawer.appendChild(nav);
    mobileDrawer.appendChild(footer);

    document.body.appendChild(mobileDrawer);
  }

  function rebuildMobileMenu() {
    if (!mobileDrawer) {
      return;
    }

    const nav =
      mobileDrawer.querySelector('.mobile-menu-nav');

    if (!nav) {
      return;
    }

    nav.innerHTML = '';

    const originalButtons = getNavTabs();

    originalButtons.forEach(function (originalButton) {

      /*
       * Respeita display:none usado pelo sistema
       * para permissões e módulos.
       */

      const computedStyle =
        window.getComputedStyle(originalButton);

      if (
        computedStyle.display === 'none' ||
        originalButton.hidden
      ) {
        return;
      }


      const mobileItem =
        document.createElement('button');

      mobileItem.type = 'button';

      mobileItem.className =
        'mobile-menu-item';


      /*
       * Mantém referência ao botão original.
       */

      mobileItem.dataset.targetId =
        originalButton.id || '';


      const icon =
        document.createElement('span');

      icon.className =
        'mobile-menu-item-icon';

      icon.textContent =
        getButtonIcon(originalButton);


      const label =
        document.createElement('span');

      label.className =
        'mobile-menu-item-label';

      label.textContent =
        getButtonLabel(originalButton);


      mobileItem.appendChild(icon);
      mobileItem.appendChild(label);


      /*
       * Marca a página atual.
       */

      if (
        originalButton.classList.contains('active')
      ) {
        mobileItem.classList.add('active');
      }


      mobileItem.addEventListener(
        'click',
        function () {

          /*
           * Usa o botão original.
           * Assim não duplicamos switchTab(),
           * permissões ou qualquer outra lógica.
           */

          if (originalButton) {
            originalButton.click();
          }

          closeMobileMenu();
        }
      );


      nav.appendChild(mobileItem);
    });
  }

  function syncMobileMenu() {
    if (!mobileDrawer) {
      return;
    }

    const originalButtons =
      getNavTabs();

    const mobileItems =
      Array.from(
        mobileDrawer.querySelectorAll(
          '.mobile-menu-item'
        )
      );

    mobileItems.forEach(function (item) {

      const targetId =
        item.dataset.targetId;

      const original =
        document.getElementById(targetId);

      if (!original) {
        return;
      }

      const isActive =
        original.classList.contains('active');

      item.classList.toggle(
        'active',
        isActive
      );

      const computedStyle =
        window.getComputedStyle(original);

      const visible =
        computedStyle.display !== 'none' &&
        !original.hidden;

      item.style.display =
        visible ? 'flex' : 'none';
    });


    /*
     * Atualiza usuário.
     */

    const user =
      mobileDrawer.querySelector(
        '.mobile-menu-user'
      );

    if (user) {
      const name =
        getCurrentUserName();

      const role =
        getCurrentUserRole();

      if (name && role) {
        user.textContent =
          `${name} · ${role}`;
      } else {
        user.textContent =
          name || '';
      }
    }


    const title =
      mobileDrawer.querySelector(
        '.mobile-menu-title'
      );

    if (title) {
      title.textContent =
        getBrandName();
    }


    const footerUser =
      mobileDrawer.querySelector(
        '.mobile-menu-footer-user div'
      );

    if (footerUser) {
      const name =
        getCurrentUserName();

      footerUser.textContent =
        name
          ? `Usuário: ${name}`
          : 'Controle de Embalagens';
    }
  }

  function openMobileMenu() {

    if (!isMobile()) {
      return;
    }

    createMobileButton();
    createMobileStructure();

    rebuildMobileMenu();
    syncMobileMenu();

    document.body.classList.add(
      'mobile-menu-open'
    );

    if (mobileButton) {
      mobileButton.setAttribute(
        'aria-expanded',
        'true'
      );

      mobileButton.setAttribute(
        'aria-label',
        'Fechar menu de navegação'
      );
    }

    if (mobileDrawer) {
      mobileDrawer.setAttribute(
        'aria-hidden',
        'false'
      );
    }

    if (mobileBackdrop) {
      mobileBackdrop.setAttribute(
        'aria-hidden',
        'false'
      );
    }

    /*
     * Impede a página de rolar atrás do drawer.
     */

    document.documentElement.style.overflow =
      'hidden';

    document.body.style.overflow =
      'hidden';


    /*
     * Foco no primeiro item navegável.
     */

    requestAnimationFrame(function () {

      const firstItem =
        mobileDrawer?.querySelector(
          '.mobile-menu-item'
        );

      if (firstItem) {
        firstItem.focus();
      }

    });
  }

  function closeMobileMenu() {

    document.body.classList.remove(
      'mobile-menu-open'
    );

    if (mobileButton) {
      mobileButton.setAttribute(
        'aria-expanded',
        'false'
      );

      mobileButton.setAttribute(
        'aria-label',
        'Abrir menu de navegação'
      );
    }

    if (mobileDrawer) {
      mobileDrawer.setAttribute(
        'aria-hidden',
        'true'
      );
    }

    if (mobileBackdrop) {
      mobileBackdrop.setAttribute(
        'aria-hidden',
        'true'
      );
    }


    /*
     * Restaura o scroll da página.
     */

    document.documentElement.style.overflow =
      '';

    document.body.style.overflow =
      '';
  }

  function handleEscape(event) {

    if (
      event.key === 'Escape' &&
      document.body.classList.contains(
        'mobile-menu-open'
      )
    ) {
      closeMobileMenu();
    }
  }

  function handleResize() {

    if (!isMobile()) {
      closeMobileMenu();
    }

    syncMobileMenu();
  }

  function initResponsiveMenu() {

    createMobileButton();
    createMobileStructure();

    document.addEventListener(
      'keydown',
      handleEscape
    );

    window.addEventListener(
      'resize',
      handleResize,
      { passive: true }
    );

    window.addEventListener(
      'orientationchange',
      function () {
        setTimeout(
          handleResize,
          100
        );
      },
      { passive: true }
    );

    /*
     * Permite que mudanças de permissão
     * sejam refletidas no menu.
     */

    const nav =
      document.querySelector('.nav-tabs');

    if (nav) {

      const observer =
        new MutationObserver(
          function () {
            if (
              document.body.classList.contains(
                'mobile-menu-open'
              )
            ) {
              rebuildMobileMenu();
              syncMobileMenu();
            }
          }
        );

      observer.observe(
        nav,
        {
          attributes: true,
          attributeFilter: [
            'style',
            'class',
            'hidden'
          ],
          subtree: true
        }
      );
    }

    /*
     * Pequeno atraso para pegar o nome/role
     * depois da autenticação.
     */

    setTimeout(
      syncMobileMenu,
      1000
    );

    setTimeout(
      syncMobileMenu,
      3000
    );
  }


  /*
   * Aguarda o DOM.
   */

  if (
    document.readyState === 'loading'
  ) {

    document.addEventListener(
      'DOMContentLoaded',
      initResponsiveMenu,
      { once: true }
    );

  } else {

    initResponsiveMenu();

  }


  /*
   * Expõe funções para eventual uso futuro.
   */

  window.MobileNavigation = {
    open: openMobileMenu,
    close: closeMobileMenu,
    rebuild: rebuildMobileMenu,
    sync: syncMobileMenu
  };

})();
