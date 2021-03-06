import { inject as service } from '@ember/service';
import Route from '@ember/routing/route';
import RSVP from 'rsvp';
import fetch from 'fetch';
import config from 'thirdeye-frontend/config/environment';
import AuthenticatedRouteMixin from 'ember-simple-auth/mixins/authenticated-route-mixin';
import {
  toCurrentUrn,
  toBaselineUrn,
  dateFormatFull,
  appendFilters,
  filterPrefix,
  makeTime,
  value2filter
} from 'thirdeye-frontend/utils/rca-utils';
import { checkStatus } from 'thirdeye-frontend/utils/utils';
import _ from 'lodash';

const ROOTCAUSE_SETUP_MODE_CONTEXT = "context";
const ROOTCAUSE_SETUP_MODE_SELECTED = "selected";
const ROOTCAUSE_SETUP_MODE_NONE = "none";

const UNIT_MAPPING = {
  NANOSECONDS: 'nanosecond',
  MILLISECONDS: 'millisecond',
  SECONDS: 'second',
  MINUTES: 'minute',
  HOURS: 'hour',
  DAYS: 'day'
};

/**
 * adjusts RCA backend granularity to a sane scale
 */
const adjustGranularity = (attrGranularity) => {
  const [count, unit] = attrGranularity.split('_');
  const granularity = [parseInt(count, 10), unit];

  if (['NANOSECONDS', 'MILLISECONDS', 'SECONDS'].includes(granularity[1])) {
    granularity[0] = 5;
    granularity[1] = 'MINUTES';
  }

  if (['MINUTES'].includes(granularity[1])) {
    granularity[0] = Math.max(granularity[0], 5);
    granularity[1] = 'MINUTES';
  }

  return granularity[0] + "_" + granularity[1];
};

/**
 * adjusts metric max time based on metric granularity
 */
const adjustMaxTime = (maxTime, metricGranularity) => {
  const time = makeTime(parseInt(maxTime, 10));
  const [count, unit] = metricGranularity;

  const start = time.startOf(unit);
  const remainder = start.get(unit) % count;

  return start.add(-1 * remainder, unit);
};

/**
 * converts RCA backend granularity strings into units understood by moment.js
 */
const toMetricGranularity = (attrGranularity) => {
  const [count, unit] = attrGranularity.split('_');
  return [parseInt(count, 10), UNIT_MAPPING[unit]];
};

/**
 * Returns the anomaly time range offset (in granularity units) based on metric granularity
 */
const toAnomalyOffset = (granularity) => {
  const UNIT_MAPPING = {
    minute: -120,
    hour: -3,
    day: -1
  };
  return UNIT_MAPPING[granularity[1]] || -1;
};

/**
 * Returns the analysis time range offset (in days) based on metric granularity
 */
const toAnalysisOffset = (granularity) => {
  const UNIT_MAPPING = {
    minute: -1,
    hour: -2,
    day: -7
  };
  return UNIT_MAPPING[granularity[1]] || -1;
};

/**
 * Returns the array for start/end dates of the analysis range
 */
const toAnalysisRangeArray = (anomalyStart, anomalyEnd, metricGranularity) => {
  const analysisRangeStartOffset = toAnalysisOffset(metricGranularity);
  const analysisRangeEnd = makeTime(anomalyEnd).startOf('day').add(1, 'day').valueOf();
  const analysisRangeStart = makeTime(anomalyStart).startOf('day').add(analysisRangeStartOffset, 'day').valueOf();
  return [analysisRangeStart, analysisRangeEnd];
};

export default Route.extend(AuthenticatedRouteMixin, {
  authService: service('session'),
  session: service(),

  queryParams: {
    metricId: {
      refreshModel: true,
      replace: true
    },
    sessionId: {
      refreshModel: false,
      replace: false
    },
    anomalyId: {
      refreshModel: true,
      replace: false
    }
  },

  model(params) {
    const { metricId, sessionId, anomalyId } = params;
    const isDevEnv = config.environment === 'development';

    let metricUrn, metricEntity, session, anomalyUrn, anomalyEntity, anomalySessions;

    if (metricId) {
      metricUrn = `thirdeye:metric:${metricId}`;
      metricEntity = fetch(`/rootcause/raw?framework=identity&urns=${metricUrn}`).then(checkStatus).then(res => res[0]).catch(() => {});
    }

    if (anomalyId) {
      anomalyUrn = `thirdeye:event:anomaly:${anomalyId}`;
      anomalyEntity = fetch(`/rootcause/raw?framework=identity&urns=${anomalyUrn}`).then(checkStatus).then(res => res[0]).catch(() => {});
      anomalySessions = fetch(`/session/query?anomalyId=${anomalyId}`).then(checkStatus).catch(() => {});
    }

    if (sessionId) {
      session = fetch(`/session/${sessionId}`).then(checkStatus).catch(() => {});
    }

    return RSVP.hash({
      isDevEnv,
      metricId,
      metricUrn,
      metricEntity,
      sessionId,
      session,
      anomalyId,
      anomalyUrn,
      anomalyEntity,
      anomalySessions
    });
  },

  /**
   * @description Resets any query params to allow not to have leak state or sticky query-param
   * @method resetController
   * @param {Object} controller - active controller
   * @param {Boolean} isExiting - exit status
   * @return {undefined}
   */
  resetController(controller, isExiting) {
    this._super(...arguments);
    if (isExiting) {
      controller.set('sessionId', null);
    }
  },

  afterModel(model, transition) {
    const defaultParams = {
      anomalyRangeStart: makeTime().startOf('hour').subtract(3, 'hour').valueOf(),
      anomalyRangeEnd: makeTime().startOf('hour').valueOf(),
      analysisRangeStart: makeTime().startOf('day').subtract(6, 'day').valueOf(),
      analysisRangeEnd: makeTime().startOf('day').add(1, 'day').valueOf(),
      granularity: '1_HOURS',
      compareMode: 'WoW'
    };

    // default params
    const { queryParams } = transition;
    const newModel = Object.assign(model, { ...defaultParams, ...queryParams });

    // load latest saved session for anomaly
    const { anomalySessions } = model;
    if (!_.isEmpty(anomalySessions)) {
      const mostRecent = _.last(_.sortBy(anomalySessions, 'updated'));

      Object.assign(newModel, {
        anomalyId: null,
        anomalyUrn: null,
        anomalyContext: null,
        sessionId: mostRecent.id,
        session: mostRecent
      });

      // NOTE: apparently this does not abort the ongoing transition
      this.transitionTo({ queryParams: { sessionId: mostRecent.id, anomalyId: null } });
    }

    return newModel;
  },

  setupController(controller, model) {
    this._super(...arguments);

    const {
      analysisRangeStart,
      analysisRangeEnd,
      granularity,
      compareMode,
      anomalyRangeStart,
      anomalyRangeEnd,
      metricId,
      metricUrn,
      metricEntity,
      sessionId,
      session,
      anomalyId,
      anomalyUrn,
      anomalyEntity
    } = model;

    const anomalyRange = [anomalyRangeStart, anomalyRangeEnd];
    const analysisRange = [analysisRangeStart, analysisRangeEnd];

    // default blank context
    let context = {
      urns: new Set(),
      anomalyRange,
      analysisRange,
      granularity,
      compareMode,
      anomalyUrns: new Set()
    };

    let selectedUrns = new Set();
    let sessionName = 'New Investigation (' + makeTime().format(dateFormatFull) + ')';
    let sessionText = '';
    let sessionOwner = this.get('authService.data.authenticated.name');
    let sessionPermissions = 'READ_WRITE';
    let sessionUpdatedBy = '';
    let sessionUpdatedTime = '';
    let sessionModified = true;
    let setupMode = ROOTCAUSE_SETUP_MODE_CONTEXT;
    let routeErrors = new Set();

    // metric-initialized context
    if (metricId && metricUrn) {
      if (!_.isEmpty(metricEntity)) {
        const granularity = adjustGranularity(metricEntity.attributes.granularity[0]);
        const metricGranularity = toMetricGranularity(granularity);
        const maxTime = adjustMaxTime(metricEntity.attributes.maxTime[0], metricGranularity);

        const anomalyRangeEnd = makeTime(maxTime).startOf(metricGranularity[1]).valueOf();
        const anomalyRangeStartOffset = toAnomalyOffset(metricGranularity);
        const anomalyRangeStart = makeTime(anomalyRangeEnd).add(anomalyRangeStartOffset, metricGranularity[1]).valueOf();
        const anomalyRange = [anomalyRangeStart, anomalyRangeEnd];

        // align to local end of day
        const analysisRange = toAnalysisRangeArray(anomalyRangeEnd, anomalyRangeEnd, metricGranularity);

        context = {
          urns: new Set([metricUrn]),
          anomalyRange,
          analysisRange,
          granularity: (granularity === '1_DAYS') ? '1_HOURS' : granularity,
          compareMode,
          anomalyUrns: new Set()
        };

        selectedUrns = new Set([metricUrn, toCurrentUrn(metricUrn), toBaselineUrn(metricUrn)]);
        setupMode = ROOTCAUSE_SETUP_MODE_SELECTED;
      }
    }

    // anomaly-initialized context
    if (anomalyId && anomalyUrn) {
      if (!_.isEmpty(anomalyEntity)) {
        const granularity = adjustGranularity(anomalyEntity.attributes.metricGranularity[0]);
        const metricGranularity = toMetricGranularity(granularity);
        const anomalyRange = [parseInt(anomalyEntity.start, 10), parseInt(anomalyEntity.end, 10)];
        // align to local end of day (anomalyStart, anomalyEnd, metricGranularity)
        const analysisRange = toAnalysisRangeArray(anomalyRange[0], anomalyRange[1], metricGranularity);

        const anomalyDimNames = anomalyEntity.attributes['dimensions'] || [];
        const anomalyFilters = [];
        anomalyDimNames.forEach(dimName => {
          anomalyEntity.attributes[dimName].forEach(dimValue => {
            anomalyFilters.pushObject(value2filter(dimName, dimValue));
          });
        });

        const anomalyMetricUrnRaw = `thirdeye:metric:${anomalyEntity.attributes['metricId'][0]}`;
        const anomalyMetricUrn = appendFilters(anomalyMetricUrnRaw, anomalyFilters);

        const anomalyFunctionUrns = [];
        if (!_.isEmpty(anomalyEntity.attributes['functionId'])) {
          const anomalyFunctionUrnRaw = `frontend:anomalyfunction:${anomalyEntity.attributes['functionId'][0]}`;
          anomalyFunctionUrns.pushObject(appendFilters(anomalyFunctionUrnRaw, anomalyFilters));
        }

        context = {
          urns: new Set([anomalyMetricUrn]),
          anomalyRange,
          analysisRange,
          granularity,
          compareMode: 'WoW',
          anomalyUrns: new Set([anomalyUrn, anomalyMetricUrn].concat(anomalyFunctionUrns))
        };

        selectedUrns = new Set([anomalyUrn, anomalyMetricUrn]);
        sessionName = 'New Investigation of #' + anomalyId + ' (' + makeTime().format(dateFormatFull) + ')';
        setupMode = ROOTCAUSE_SETUP_MODE_SELECTED;
        sessionText = anomalyEntity.attributes.comment[0];
      } else {
        routeErrors.add(`Could not find anomalyId ${anomalyId}`);
      }
    }

    // session-initialized context
    if (sessionId) {
      if (!_.isEmpty(session)) {
        const { name, text, updatedBy, updated, owner, permissions } = model.session;
        context = {
          urns: new Set(session.contextUrns),
          anomalyRange: [session.anomalyRangeStart, session.anomalyRangeEnd],
          analysisRange: [session.analysisRangeStart, session.analysisRangeEnd],
          granularity: session.granularity,
          compareMode: session.compareMode,
          anomalyUrns: new Set(session.anomalyUrns || [])
        };
        selectedUrns = new Set(session.selectedUrns);

        sessionName = name;
        sessionText = text;
        sessionOwner = owner;
        sessionPermissions = permissions;
        sessionUpdatedBy = updatedBy;
        sessionUpdatedTime = updated;
        sessionModified = false;
        setupMode = ROOTCAUSE_SETUP_MODE_NONE;

      } else {
        routeErrors.add(`Could not find sessionId ${sessionId}`);
      }
    }

    // update secondary metrics
    const sizeMetricUrns = new Set(filterPrefix(context.urns, 'thirdeye:metric:'));

    controller.setProperties({
      routeErrors,
      anomalyId,
      metricId,
      sessionId,
      sessionName,
      sessionText,
      sessionOwner,
      sessionPermissions,
      sessionUpdatedBy,
      sessionUpdatedTime,
      sessionModified,
      selectedUrns,
      sizeMetricUrns,
      setupMode,
      context
    });
  },

  actions: {
    /**
     * save session url for transition on login
     * @method willTransition
     */
    willTransition(transition) {
      //saving session url - TODO: add a util or service - lohuynh
      if (transition.intent.name && transition.intent.name !== 'logout') {
        this.set('session.store.fromUrl', {lastIntentTransition: transition});
      }
    },
    error() {
      // The `error` hook is also provided the failed
      // `transition`, which can be stored and later
      // `.retry()`d if desired.
      return true;
    }
  }
});
