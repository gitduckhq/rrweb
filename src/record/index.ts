import { snapshot, MaskInputOptions, SlimDOMOptions } from 'rrweb-snapshot';
import { initObservers, mutationBuffers } from './observer';
import {
  mirror,
  on,
  getWindowWidth,
  getWindowHeight,
  polyfill,
  isIframeINode,
} from '../utils';
import {
  EventType,
  event,
  eventWithTime,
  recordOptions,
  IncrementalSource,
  listenerHandler,
  LogRecordOptions,
} from '../types';
import { IframeManager } from './iframe-manager';

function wrapEvent(e: event): eventWithTime {
  return {
    ...e,
    timestamp: Date.now(),
  };
}

export class Recorder<T = eventWithTime> {
  private readonly wrappedEmit: (e: eventWithTime, isCheckout?: boolean) => void;
  private readonly iframeManager: IframeManager
  private readonly observe: (doc: Document) => listenerHandler
  private recording: boolean = false

  private readonly snapshotOptions: {
    blockClass?: string | RegExp;
    inlineStylesheet?: boolean;
    maskAllInputs?: boolean | MaskInputOptions;
    slimDOM?: boolean | SlimDOMOptions;
    recordCanvas?: boolean;
    blockSelector?: string | null;
  }

  constructor (
    onEmit: (e: T, isCheckout?: boolean) => void,
    options: Exclude<recordOptions<T>, 'emit'> = {},
  ) {
    const {
      checkoutEveryNms, 
      checkoutEveryNth,
      blockClass = 'rr-block',
      blockSelector = null,
      ignoreClass = 'rr-ignore',
      inlineStylesheet = true,
      maskAllInputs,
      maskInputOptions: _maskInputOptions,
      slimDOMOptions: _slimDOMOptions,
      maskInputFn,
      hooks,
      packFn,
      sampling = {},
      mousemoveWait,
      recordCanvas = false,
      collectFonts = false,
      recordLog = false,
    } = options;

    // move deprecated options to new options
    if (mousemoveWait !== undefined && sampling.mousemove === undefined) {
      sampling.mousemove = mousemoveWait;
    }

    const maskInputOptions: MaskInputOptions =
      maskAllInputs === true
        ? {
            color: true,
            date: true,
            'datetime-local': true,
            email: true,
            month: true,
            number: true,
            range: true,
            search: true,
            tel: true,
            text: true,
            time: true,
            url: true,
            week: true,
            textarea: true,
            select: true,
          }
        : _maskInputOptions !== undefined
          ? _maskInputOptions
          : {};

    const slimDOMOptions: SlimDOMOptions =
      _slimDOMOptions === true || _slimDOMOptions === 'all'
        ? {
            script: true,
            comment: true,
            headFavicon: true,
            headWhitespace: true,
            headMetaSocial: true,
            headMetaRobots: true,
            headMetaHttpEquiv: true,
            headMetaVerification: true,
            // the following are off for slimDOMOptions === true,
            // as they destroy some (hidden) info:
            headMetaAuthorship: _slimDOMOptions === 'all',
            headMetaDescKeywords: _slimDOMOptions === 'all',
          }
        : _slimDOMOptions
          ? _slimDOMOptions
          : {};

    this.snapshotOptions = {
      blockClass,
      inlineStylesheet,
      maskAllInputs,
      slimDOM: slimDOMOptions,
      recordCanvas,
      blockSelector,
    }

    const defaultLogOptions: LogRecordOptions = {
      level: [
        'assert',
        'clear',
        'count',
        'countReset',
        'debug',
        'dir',
        'dirxml',
        'error',
        'group',
        'groupCollapsed',
        'groupEnd',
        'info',
        'log',
        'table',
        'time',
        'timeEnd',
        'timeLog',
        'trace',
        'warn',
      ],
      lengthThreshold: 1000,
      logger: console,
    };

    const logOptions: LogRecordOptions = recordLog
      ? recordLog === true
        ? defaultLogOptions
        : Object.assign({}, defaultLogOptions, recordLog)
      : {};

    polyfill();

    let lastFullSnapshotEvent: eventWithTime;
    let incrementalSnapshotCount = 0;
    this.wrappedEmit = (e: eventWithTime, isCheckout?: boolean) => {
      if (
        mutationBuffers[0]?.isFrozen() &&
        e.type !== EventType.FullSnapshot &&
        !(
          e.type === EventType.IncrementalSnapshot &&
          e.data.source === IncrementalSource.Mutation
        )
      ) {
        // we've got a user initiated event so first we need to apply
        // all DOM changes that have been buffering during paused state
        mutationBuffers.forEach((buf) => buf.unfreeze());
      }

      onEmit(((packFn ? packFn(e) : e) as unknown) as T, isCheckout);
      if (e.type === EventType.FullSnapshot) {
        lastFullSnapshotEvent = e;
        incrementalSnapshotCount = 0;
      } else if (e.type === EventType.IncrementalSnapshot) {
        incrementalSnapshotCount++;
        const exceedCount =
          checkoutEveryNth && incrementalSnapshotCount >= checkoutEveryNth;
        const exceedTime =
          checkoutEveryNms &&
          e.timestamp - lastFullSnapshotEvent.timestamp > checkoutEveryNms;
        if (exceedCount || exceedTime) {
          this.takeFullSnapshot(true);
        }
      }
    };

    const iframeManager = this.iframeManager = new IframeManager({
      mutationCb: (m) =>
        this.wrappedEmit(
          wrapEvent({
            type: EventType.IncrementalSnapshot,
            data: {
              source: IncrementalSource.Mutation,
              ...m,
            },
          }),
        ),
    });

    this.observe = (doc: Document) => {
      return initObservers(
        {
          mutationCb: (m) =>
            this.wrappedEmit(
              wrapEvent({
                type: EventType.IncrementalSnapshot,
                data: {
                  source: IncrementalSource.Mutation,
                  ...m,
                },
              }),
            ),
          mousemoveCb: (positions, source) =>
            this.wrappedEmit(
              wrapEvent({
                type: EventType.IncrementalSnapshot,
                data: {
                  source,
                  positions,
                },
              }),
            ),
          mouseInteractionCb: (d) =>
            this.wrappedEmit(
              wrapEvent({
                type: EventType.IncrementalSnapshot,
                data: {
                  source: IncrementalSource.MouseInteraction,
                  ...d,
                },
              }),
            ),
          scrollCb: (p) =>
            this.wrappedEmit(
              wrapEvent({
                type: EventType.IncrementalSnapshot,
                data: {
                  source: IncrementalSource.Scroll,
                  ...p,
                },
              }),
            ),
          viewportResizeCb: (d) =>
            this.wrappedEmit(
              wrapEvent({
                type: EventType.IncrementalSnapshot,
                data: {
                  source: IncrementalSource.ViewportResize,
                  ...d,
                },
              }),
            ),
          inputCb: (v) =>
            this.wrappedEmit(
              wrapEvent({
                type: EventType.IncrementalSnapshot,
                data: {
                  source: IncrementalSource.Input,
                  ...v,
                },
              }),
            ),
          mediaInteractionCb: (p) =>
            this.wrappedEmit(
              wrapEvent({
                type: EventType.IncrementalSnapshot,
                data: {
                  source: IncrementalSource.MediaInteraction,
                  ...p,
                },
              }),
            ),
          styleSheetRuleCb: (r) =>
            this.wrappedEmit(
              wrapEvent({
                type: EventType.IncrementalSnapshot,
                data: {
                  source: IncrementalSource.StyleSheetRule,
                  ...r,
                },
              }),
            ),
          canvasMutationCb: (p) =>
            this.wrappedEmit(
              wrapEvent({
                type: EventType.IncrementalSnapshot,
                data: {
                  source: IncrementalSource.CanvasMutation,
                  ...p,
                },
              }),
            ),
          fontCb: (p) =>
            this.wrappedEmit(
              wrapEvent({
                type: EventType.IncrementalSnapshot,
                data: {
                  source: IncrementalSource.Font,
                  ...p,
                },
              }),
            ),
          logCb: (p) =>
            this.wrappedEmit(
              wrapEvent({
                type: EventType.IncrementalSnapshot,
                data: {
                  source: IncrementalSource.Log,
                  ...p,
                },
              }),
            ),
          blockClass,
          ignoreClass,
          maskInputOptions,
          inlineStylesheet,
          sampling,
          recordCanvas,
          collectFonts,
          doc,
          maskInputFn,
          logOptions,
          blockSelector,
          slimDOMOptions,
          iframeManager,
        },
        hooks,
      );
    };
  }

  takeFullSnapshot(isCheckout = false) {
    this.wrappedEmit(
      wrapEvent({
        type: EventType.Meta,
        data: {
          href: window.location.href,
          width: getWindowWidth(),
          height: getWindowHeight(),
        },
      }),
      isCheckout,
    );

    mutationBuffers.forEach((buf) => buf.lock()); // don't allow any mirror modifications during snapshotting
    const [node, idNodeMap] = snapshot(document, {
      ...this.snapshotOptions,
      onSerialize: (n) => {
        if (isIframeINode(n)) {
          this.iframeManager.addIframe(n);
        }
      },
      onIframeLoad: (iframe, childSn) => {
        this.iframeManager.attachIframe(iframe, childSn);
      },
    });

    if (!node) {
      return console.warn('Failed to snapshot the document');
    }

    mirror.map = idNodeMap;
    this.wrappedEmit(
      wrapEvent({
        type: EventType.FullSnapshot,
        data: {
          node,
          initialOffset: {
            left:
              window.pageXOffset !== undefined
                ? window.pageXOffset
                : document?.documentElement.scrollLeft ||
                  document?.body?.parentElement?.scrollLeft ||
                  document?.body.scrollLeft ||
                  0,
            top:
              window.pageYOffset !== undefined
                ? window.pageYOffset
                : document?.documentElement.scrollTop ||
                  document?.body?.parentElement?.scrollTop ||
                  document?.body.scrollTop ||
                  0,
          },
        },
      }),
    );
    mutationBuffers.forEach((buf) => buf.unlock()); // generate & emit any mutations that happened during snapshotting, as can now apply against the newly built mirror
  }

  record(): listenerHandler | undefined {
    try {
      const handlers: listenerHandler[] = [];
      handlers.push(
        on('DOMContentLoaded', () => {
          this.wrappedEmit(
            wrapEvent({
              type: EventType.DomContentLoaded,
              data: {},
            }),
          );
        }),
      );

      this.iframeManager.addLoadListener((iframeEl) => {
        handlers.push(this.observe(iframeEl.contentDocument!));
      });

      const init = () => {
        this.takeFullSnapshot();
        handlers.push(this.observe(document));
      };
      if (
        document.readyState === 'interactive' ||
        document.readyState === 'complete'
      ) {
        init();
      } else {
        handlers.push(
          on(
            'load',
            () => {
              this.wrappedEmit(
                wrapEvent({
                  type: EventType.Load,
                  data: {},
                }),
              );
              init();
            },
            window,
          ),
        );
      }
      return () => {
        handlers.forEach((h) => h());
      };
    } catch (error) {
      // TODO: handle internal error
      console.warn(error);
    }
  }

  addCustomEvent = (tag: string, payload: T) => {
    if (!this.recording) {
      throw new Error('please add custom event after start recording');
    }

    this.wrappedEmit(
      wrapEvent({
        type: EventType.Custom,
        data: {
          tag,
          payload,
        },
      }),
    );
  };

  freezePage = () => {
    mutationBuffers.forEach((buf) => buf.freeze());
  };
}

let recorder: Recorder<any>

function record<T = eventWithTime>(
  options: recordOptions<T> = {},
): listenerHandler | undefined {
  const {
    emit,
  } = options;
  // runtime checks for user options
  if (!emit) {
    throw new Error('emit function is required');
  }

  recorder = new Recorder(emit, options)
  return recorder.record()
}

record.addCustomEvent = <T>(tag: string, payload: T) => {
  if (!recorder) {
    throw new Error('please add custom event after start recording');
  }
  recorder.addCustomEvent(tag, payload)
};

record.freezePage = () => {
  recorder.freezePage();
};

export default record;
