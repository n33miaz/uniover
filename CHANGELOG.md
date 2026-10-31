# Changelog

## [0.30.0](https://github.com/n33miaz/uniover/compare/v0.29.0...v0.30.0) (2026-10-31)


### Features

* **contracts:** add pc control messages
* **agent:** add gated pc control
* **api:** add pc control routes and permission
* **web:** grant and audit the pc module
* **web:** add the pc control module


### Bug Fixes

* **api:** drive the caller's own pc first

## [0.29.0](https://github.com/n33miaz/uniover/compare/v0.28.0...v0.29.0) (2026-10-31)


### Features

* **contracts:** add tv launcher config schema
* **tv-launcher:** add home, sleep mode and config

## [0.28.0](https://github.com/n33miaz/uniover/compare/v0.27.0...v0.28.0) (2026-10-31)


### Features

* **training:** catalog read timeout and retry


### Bug Fixes

* **training:** read catalog in batches, no cursor

## [0.27.0](https://github.com/n33miaz/uniover/compare/v0.26.0...v0.27.0) (2026-10-31)


### Features

* **training:** fixed save bar on the editors


### Bug Fixes

* **training:** keep illustrations for offline use


### Performance Improvements

* **training:** lighter catalog search and rows

## [0.26.0](https://github.com/n33miaz/uniover/compare/v0.25.0...v0.26.0) (2026-10-31)


### Features

* **web:** complete exercise illustrations
* **api:** publish photo routes only when enabled
* **web:** retire cloud photos, add previews
* **web:** block selection and tap highlight


### Performance Improvements

* **web:** lazy exercise thumbnails

## [0.25.0](https://github.com/n33miaz/uniover/compare/v0.24.0...v0.25.0) (2026-10-31)


### Features

* **web:** shared loading frame and skeletons
* **web:** skeletons in settings and devices
* **training:** shaped skeletons on every screen


### Bug Fixes

* **training:** skeleton classes and shapes

## [0.24.0](https://github.com/n33miaz/uniover/compare/v0.23.0...v0.24.0) (2026-10-31)


### Bug Fixes

* **web:** add room under the page top bar
* **home:** center the brand text on the screen
* **training:** title case chips and routine name

## [0.23.0](https://github.com/n33miaz/uniover/compare/v0.22.0...v0.23.0) (2026-10-31)


### Features

* **tv:** say if the TV has an agent linked
* **home:** centered brand and discreet agent dot
* **home:** clearer customize sheet
* **contracts:** focus closes background field
* **api:** focus closes background per TV
* **agent:** close background apps in focus mode
* **web:** close other apps in focus switch


### Bug Fixes

* **home:** scale sheet glyphs, hide arrows
* **agent:** focus needs the media owner in front
* **agent:** protect Google TV, log sweep cap
* **api:** refuse focus closing without capability
* **api:** latest cleanup skips focus reports

## [0.22.0](https://github.com/n33miaz/uniover/compare/v0.21.0...v0.22.0) (2026-10-30)


### Features

* **tv:** say if the TV has an agent linked
* **home:** centered brand and discreet agent dot
* **home:** clearer customize sheet

## [0.21.0](https://github.com/n33miaz/uniover/compare/v0.20.0...v0.21.0) (2026-10-30)


### Features

* **web:** add the shared page top bar
* **training:** sync ring and state sheet
* **training:** thumbnails in the open routine
* **training:** body map values per region
* **training:** one top bar and a single back

## [0.20.0](https://github.com/n33miaz/uniover/compare/v0.19.0...v0.20.0) (2026-10-30)


### Features

* **web:** standard top bar for module screens
* **web:** title-only settings with theme selector
* **web:** shorter settings copy and wide action


### Bug Fixes

* **web:** drop agent state when TV is hidden
* **web:** no focus ring on top bar title
* **web:** devices dead code and owner hint

## [0.19.0](https://github.com/n33miaz/uniover/compare/v0.18.4...v0.19.0) (2026-10-30)


### Features

* **api:** mark one agent alert as seen
* **api:** guest invites last 7 days
* **web:** refresh devices screen
* **web:** collapse the qr login panel
* **web:** skeletons in settings screens
* **web:** guest sees own agent state
* **web:** guest security shows own sessions
* **web:** drop usage counters from people


### Bug Fixes

* **web:** keep power button in view

## [0.18.4](https://github.com/n33miaz/uniover/compare/v0.18.3...v0.18.4) (2026-10-30)


### Bug Fixes

* **ci:** trust roots for audit cleanup

## [0.18.3](https://github.com/n33miaz/uniover/compare/v0.18.2...v0.18.3) (2026-10-30)


### Features

* **training:** refresh today and week

## [0.18.2](https://github.com/n33miaz/uniover/compare/v0.18.1...v0.18.2) (2026-10-29)


### Bug Fixes

* **tv:** read volume across devices

## [0.18.1](https://github.com/n33miaz/uniover/compare/v0.18.0...v0.18.1) (2026-10-29)


### Features

* **web:** add safe-area and keyboard tokens


### Bug Fixes

* **web:** use safe-bottom token on footers
* **web:** lift sheets and tabs above keyboard
* **web:** stop keyboard watcher on destroy
* **web:** drop doubled safe inset in training

## [0.18.0](https://github.com/n33miaz/uniover/compare/v0.17.0...v0.18.0) (2026-10-28)


### Features

* **web:** home top, cards and customize
* **web:** guest home and one back


### Bug Fixes

* **web:** animated skeleton on slow open

## [0.17.0](https://github.com/n33miaz/uniover/compare/v0.16.0...v0.17.0) (2026-10-28)


### Features

* **training:** live set as option C
* **training:** record on rest, hints folded
* **training:** start from the next routine
* **training:** six more exercise drawings


### Bug Fixes

* **training:** same size for art and muscles
* **training:** glossary terms and title case
* **training:** keep 56px steppers on press

## [0.16.0](https://github.com/n33miaz/uniover/compare/v0.15.0...v0.16.0) (2026-10-28)


### Features

* **agent:** type with the real field state
* **agent:** find the tv by mdns
* **web:** tips when tv services stop

## [0.15.0](https://github.com/n33miaz/uniover/compare/v0.14.0...v0.15.0) (2026-10-28)


### Features

* **contracts:** tv light settings capability
* **agent:** reversible tv light settings
* **tv:** store and publish light settings
* **web:** light settings on the tv sheet

## [0.14.0](https://github.com/n33miaz/uniover/compare/v0.13.1...v0.14.0) (2026-10-28)


### Features

* **training:** body signals and map polish
* **training:** mark cloud photos apart
* **tv:** app skeleton and compact schedule


### Bug Fixes

* **training:** one back on body assessments
* **tv:** cleanup text follows the per-tv switch

## [0.13.1](https://github.com/n33miaz/uniover/compare/v0.13.0...v0.13.1) (2026-10-28)


### Bug Fixes

* **devices:** allow cleanup config to the agent

## [0.13.0](https://github.com/n33miaz/uniover/compare/v0.12.0...v0.13.0) (2026-10-28)


### Features

* **api:** report photo bucket readiness
* **web:** devices readable at a glance
* **web:** health in four cards and bucket state
* **web:** tidy profile, security and appearance

## [0.12.0](https://github.com/n33miaz/uniover/compare/v0.11.1...v0.12.0) (2026-10-28)


### Features

* **training:** glossary of plan words
* **training:** bigger exercise media and map name


### Bug Fixes

* **training:** title case and unified names

## [0.11.1](https://github.com/n33miaz/uniover/compare/v0.11.0...v0.11.1) (2026-10-28)


### Bug Fixes

* **web:** never reload into the old shell

## [0.11.0](https://github.com/n33miaz/uniover/compare/v0.10.0...v0.11.0) (2026-10-28)


### Features

* **training:** sync progress photos to the cloud

## [0.10.0](https://github.com/n33miaz/uniover/compare/v0.9.0...v0.10.0) (2026-10-28)


### Features

* **contracts:** tv cleanup config message
* **agent:** schedule light and deep tv cleanup
* **tv:** per-tv app closing and cleanup reports
* **web:** cleanup reports and app closing switch

## [0.9.0](https://github.com/n33miaz/uniover/compare/v0.8.1...v0.9.0) (2026-10-28)


### Features

* **training:** sync calendar notes and absences
* **training:** store calendar entries locally
* **training:** today with week goal and month

## [0.8.1](https://github.com/n33miaz/uniover/compare/v0.8.0...v0.8.1) (2026-10-28)


### Features

* **web:** update skeleton mirrors the home


### Bug Fixes

* **web:** never hold the first screen on /me

## [0.8.0](https://github.com/n33miaz/uniover/compare/v0.7.0...v0.8.0) (2026-10-28)


### Features

* **training:** store full body measurements
* **training:** measure both sides of the body
* **training:** body map inside the body tab

## [0.7.0](https://github.com/n33miaz/uniover/compare/v0.6.0...v0.7.0) (2026-10-28)


### Features

* **training:** auto-alternate exercise poses
* **training:** clearer sync status button
* **training:** rework the live session screens


### Bug Fixes

* **training:** back returns to the right screen
* **training:** restore back on exercise detail
* **training:** only flag a real next routine

## [0.6.0](https://github.com/n33miaz/uniover/compare/v0.5.2...v0.6.0) (2026-10-27)


### Features

* **api:** count usage per person
* **api:** alert when an agent goes offline
* **web:** show usage per person
* **web:** show agent offline alerts

## [0.5.2](https://github.com/n33miaz/uniover/compare/v0.5.1...v0.5.2) (2026-10-27)


### Bug Fixes

* **web:** make update replace the shell

## [0.5.1](https://github.com/n33miaz/uniover/compare/v0.5.0...v0.5.1) (2026-10-27)


### Bug Fixes

* **training:** fit weight chart to data

## [0.5.0](https://github.com/n33miaz/uniover/compare/v0.4.3...v0.5.0) (2026-10-27)


### Features

* **release:** version every publication from one VERSION file, with a tag and a GitHub Release
* **api:** report the product version in the deployment check
* **web:** show the published version on the about screen
* **agent:** report the product version


## [0.4.3](https://github.com/n33miaz/uniover/compare/v0.4.2...v0.4.3) (2026-10-27)


### Features

* **training:** body signals panel
* **training:** title case body labels


## [0.4.2](https://github.com/n33miaz/uniover/compare/v0.4.1...v0.4.2) (2026-10-27)


### Features

* **web:** show modules as app icons
* **web:** open home for guests
* **web:** rename devices and settings


## [0.4.1](https://github.com/n33miaz/uniover/compare/v0.4.0...v0.4.1) (2026-10-27)


### Features

* **training:** show exercise images first
* **training:** highlight next routine
* **training:** keep progress evolution first
* **settings:** edit system settings


### Build

* bump angular, dotnet 10.0.14 and agent dev tools


## [0.4.0](https://github.com/n33miaz/uniover/compare/v0.3.0...v0.4.0) (2026-10-21)


### Features

* **tv:** show only what permissions allow ([3dbed6f](https://github.com/n33miaz/uniover/commit/3dbed6fb69b66d137952a2149d8235d60126342e))


### Bug Fixes

* **training:** require v7 ids for new exercises ([9a5a310](https://github.com/n33miaz/uniover/commit/9a5a3108d1edb4ee8b32c3141445fa4d9b03dbde))
* **tv:** rate limit the shortcut update ([98eca6f](https://github.com/n33miaz/uniover/commit/98eca6fd90ba62d1a2e5f22e6a833bd0bbbb3ace))
* **web:** refresh session permissions in place ([2301257](https://github.com/n33miaz/uniover/commit/2301257296bb1114ecd4c9f8dfa030148a0be489))
* **web:** tell a missing permission list from none ([d02a602](https://github.com/n33miaz/uniover/commit/d02a602d68c0d810637fd5ab079f4dc09ddb8c47))

## [0.3.0](https://github.com/n33miaz/uniover/compare/v0.2.0...v0.3.0) (2026-10-21)


### Features

* **identity:** add grants and display name ([475b128](https://github.com/n33miaz/uniover/commit/475b12858d8f03401341d4d959baeb887a3f8ad8))
* **tv:** add a clean-up action for the tv ([4f2ff0e](https://github.com/n33miaz/uniover/commit/4f2ff0e12792581e493c095c845039a8de918dec))
* **tv:** fit app icons to the tile ([89aef8d](https://github.com/n33miaz/uniover/commit/89aef8d29e9e3c3372a0e207c2b411b0fcd387d1))
* **tv:** reorder shortcuts ([fd780a8](https://github.com/n33miaz/uniover/commit/fd780a81ff6496bc8e9b2f5790ead9c4197e7f17))
* **tv:** send empty text and type faster ([8d10673](https://github.com/n33miaz/uniover/commit/8d10673046685ccc0bf2c1ade4f110da0dcd4371))
* **tv:** use the remote as the app icon ([80fc1c6](https://github.com/n33miaz/uniover/commit/80fc1c62c1093d26d3f31343be78f09bfdf67017))
* **web:** keep icon and title per module ([adae822](https://github.com/n33miaz/uniover/commit/adae82240d1e151b24475b17c085431d213dc3c7))
* **web:** redesign login and invite pages ([67f264c](https://github.com/n33miaz/uniover/commit/67f264cff5608a0e560a5295fa15886208ded17d))

## [0.2.0](https://github.com/n33miaz/uniover/compare/v0.1.0...v0.2.0) (2026-10-21)


### Features

* **agent:** add adb apps and typing ([71f6580](https://github.com/n33miaz/uniover/commit/71f6580caada54cae57907f4117ccce90cb83efa))
* **agent:** add websocket link and pairing ([ac58f49](https://github.com/n33miaz/uniover/commit/ac58f490728ea6cab89bc72d84123f314e3475a8))
* **agent:** keep tv remote session warm ([8fdcf82](https://github.com/n33miaz/uniover/commit/8fdcf8202682a9d3c6ce200f10ebd4c744bcf81e))
* **agent:** publish only square app icons ([534d1b0](https://github.com/n33miaz/uniover/commit/534d1b0f6fb43b62fb2cdf43db83e1ee9ab5dddd))
* **api:** add module persistence and web edge ([09ea6cf](https://github.com/n33miaz/uniover/commit/09ea6cfb9c97e992d680bb33fdc76c2aace35180))
* **api:** add outbox event bus and dispatcher ([cf7b118](https://github.com/n33miaz/uniover/commit/cf7b11807f72c048f0b4aaf12cd977a96c1f2205))
* **contracts:** add tv messages ([215e468](https://github.com/n33miaz/uniover/commit/215e4682532b5972485ffdba794a69bb47b58907))
* **contracts:** allow empty tv text to clear ([a6c4372](https://github.com/n33miaz/uniover/commit/a6c43721e5a798d11fd313116da6a5ebc69a036c))
* **contracts:** generate typed contracts ([f3775b0](https://github.com/n33miaz/uniover/commit/f3775b09b2585867ccd3ce02815793f2b2de6c5c))
* **devices:** add agent websocket transport ([40726c1](https://github.com/n33miaz/uniover/commit/40726c10330e7364646ae1f1307d2440d19c10df))
* **devices:** add pairing and device tokens ([23f5048](https://github.com/n33miaz/uniover/commit/23f5048d08127e3a68e312309c3090707346fdc4))
* **identity:** add login and rotating sessions ([546ef2a](https://github.com/n33miaz/uniover/commit/546ef2ae894c043db3e9404bd262e7e2f497181c))
* **identity:** add passkey step-up confirmation ([e8eb8c3](https://github.com/n33miaz/uniover/commit/e8eb8c3a4c5c01a9fd2d098dc0d954a08cad2235))
* **identity:** add tv guest role and invites ([7a9ab00](https://github.com/n33miaz/uniover/commit/7a9ab00dee85201bb06c8e128adab41b6f21d556))
* **training:** add exercise art and credits ([c1b46c3](https://github.com/n33miaz/uniover/commit/c1b46c30e9e6a6cb9f7a7ebe1f5a56e8a8506e56))
* **training:** add exercise catalog ([f7d3f75](https://github.com/n33miaz/uniover/commit/f7d3f75091a59427a6ef9d90693deaa1a16131e4))
* **training:** add offline workout sessions ([d2bf32c](https://github.com/n33miaz/uniover/commit/d2bf32cba6a96d47301e3bb96e6e3414bc7f0219))
* **training:** add progress goals and export ([ac1386a](https://github.com/n33miaz/uniover/commit/ac1386a729b232a5327647d3eb50e53977e9ffb8))
* **training:** add routines and templates ([aa17871](https://github.com/n33miaz/uniover/commit/aa17871ed2f734b60b9583451e97d7e0b889eb77))
* **tv:** add real app icons ([7ff0c29](https://github.com/n33miaz/uniover/commit/7ff0c29cfab29015d87355c192baa28bdddfb766))
* **tv:** add tv module api ([368c6c1](https://github.com/n33miaz/uniover/commit/368c6c10c302363c75576f08c2ec8de534eb79f4))
* **tv:** open any installed app from the panel ([d626b50](https://github.com/n33miaz/uniover/commit/d626b503a3a84a094831de0780fa5bdfac222362))
* **tv:** rework header and personalization ([5bcc56d](https://github.com/n33miaz/uniover/commit/5bcc56d87a7cbb5ce69f5a34499ecf4c45f31997))
* **tv:** square shortcuts and app grid ([04c373b](https://github.com/n33miaz/uniover/commit/04c373b3725b8b817fff2d229febf3085371c7fc))
* **web:** add devices screen ([605c300](https://github.com/n33miaz/uniover/commit/605c3002942f8a7b21a96035ab58b43fed218f16))
* **web:** add login session and settings ([d3a8ee0](https://github.com/n33miaz/uniover/commit/d3a8ee043ab22d676cbb2d903be07bf0a138cc61))
* **web:** add module manifests and icons ([0ec30fd](https://github.com/n33miaz/uniover/commit/0ec30fd16437e00cd493875dd682b69441725fa8))
* **web:** add offline queue with idempotency ([3a1b965](https://github.com/n33miaz/uniover/commit/3a1b965d9c823753d5125f9113b1dc62301009b5))
* **web:** add planned modules and motion ([32c1807](https://github.com/n33miaz/uniover/commit/32c18075b7a155c9794ba5d2e1b228f857523129))
* **web:** add pwa shell with workbox ([c7f7a54](https://github.com/n33miaz/uniover/commit/c7f7a540e1feeaf0abce1f50120c2c7f4a9318ca))
* **web:** add tv remote screen ([4672d65](https://github.com/n33miaz/uniover/commit/4672d65a362b7dd8c4f3b596414ac9804b9c270a))
* **web:** fill tv remote and live typing ([724be5f](https://github.com/n33miaz/uniover/commit/724be5fd473629f314b3345d6f11b4368a6743fa))
* **web:** polish tv control and carousel ([b2e9250](https://github.com/n33miaz/uniover/commit/b2e9250f74e12de54207880f6bc6a1a1e47ceabf))
* **web:** redesign home and settings ([512377c](https://github.com/n33miaz/uniover/commit/512377c651be9a83854995ccf7767fe25735af30))
* **web:** show app icons in tv control ([33a07dd](https://github.com/n33miaz/uniover/commit/33a07ddaf7978e2d58e8f15b647b0088d02691cb))
* **web:** show live agent state on home ([e896c34](https://github.com/n33miaz/uniover/commit/e896c3493e5cdde05ae5ecd256f9ce1297beaa6a))
* **web:** tv modals and clickable state ([4186c21](https://github.com/n33miaz/uniover/commit/4186c21334980db4e6e2b5bb782f25766be9a713))


### Bug Fixes

* **agent:** handle tv text messages ([008df80](https://github.com/n33miaz/uniover/commit/008df806796f5cd42838665ac2bea5d69687882e))
* **api:** declare responses and empty bodies ([8c35168](https://github.com/n33miaz/uniover/commit/8c351683a104aacfd159eae0f011b2b39eacef4f))
* **identity:** tolerate early host shutdown ([80fce3d](https://github.com/n33miaz/uniover/commit/80fce3d15947379b2e1debc9f75cea28672a114f))
* **tv:** fit long names and app labels ([9ff7de2](https://github.com/n33miaz/uniover/commit/9ff7de224042f40573ae5a503e109386a04a22ea))
* **web:** avoid shared max key in outbox query ([efbc148](https://github.com/n33miaz/uniover/commit/efbc148348230a9f72c67462e31ef8b6befc8915))
* **web:** ignore late screenshot style report ([78d105f](https://github.com/n33miaz/uniover/commit/78d105f7c8cc55f194e735b10786cebdeb8f339a))

## 0.1.0 (2026-10-18)


### Features

* **agent:** scaffold python agent ([1659988](https://github.com/n33miaz/uniover/commit/1659988e79594eac3bdc39185511e8da521dcd15))
* **api:** scaffold modular api host ([f324952](https://github.com/n33miaz/uniover/commit/f3249529e9214b864cdcf71195463faeef20a02b))
* **contracts:** add agent message envelope ([c8430a7](https://github.com/n33miaz/uniover/commit/c8430a73e441c2781a0a7d3e8220fbe7118c5df0))
* **web:** scaffold angular pwa shell ([1d36d13](https://github.com/n33miaz/uniover/commit/1d36d13307f76b71d98ae5b278f8b618c0085b7e))


### Bug Fixes

* **api:** ignore tool types in host rule ([f21cf40](https://github.com/n33miaz/uniover/commit/f21cf40bf5014416e25b1b4926abaeaeeee99d7a))
* **ci:** run api tests from its folder ([cc0cb41](https://github.com/n33miaz/uniover/commit/cc0cb41200ff5d7e6774cb9c8f67c517596aab9d))
* **deps:** clear dev tooling security alerts ([752a17d](https://github.com/n33miaz/uniover/commit/752a17d3a6875acc261b28d477328ed7a9794f65))
