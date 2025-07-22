function createHeartbeatAPI(mixpanelInstance, options = {}) {
	// Configuration with defaults
	const config = {
		maxBufferTime: 300000,        // 5 minutes
		maxPropsCount: 1000,          // Max properties per event
		maxAggregatedValue: 100000,   // Max numeric aggregation
		onFlush: null,                // Flush callback
		enableLogging: false,         // Debug logging
		...options
	};

	// Internal storage for aggregated events
	const eventStore = new Map();

	// Track timers for auto-flushing
	const flushTimers = new Map();

	// Track if we've already set up page unload handlers
	let unloadHandlersSet = false;

	function log(...args) {
		if (config.enableLogging) {
			console.log('[Mixpanel Heartbeat]', ...args);
		}
	}

	function setupUnloadHandlers() {
		if (unloadHandlersSet) return;
		unloadHandlersSet = true;

		// Handle page unload with sendBeacon for better reliability
		const handleUnload = () => {
			log('Page unload detected, flushing all events');
			flushAll(true, 'pageUnload'); // Pass true to use sendBeacon
		};

		// Multiple event handlers for cross-browser compatibility
		window.addEventListener('beforeunload', handleUnload);
		window.addEventListener('pagehide', handleUnload);
		window.addEventListener('visibilitychange', () => {
			if (document.visibilityState === 'hidden') {
				handleUnload();
			}
		});
	}

	function aggregateProps(existingProps, newProps) {
		const result = { ...existingProps };

		for (const [key, newValue] of Object.entries(newProps)) {
			if (!(key in result)) {
				// New property, just add it
				result[key] = newValue;
			} else {
				const existingValue = result[key];
				const newType = typeof newValue;
				const existingType = typeof existingValue;

				if (newType === 'number' && existingType === 'number') {
					// Add numbers together
					result[key] = existingValue + newValue;
				} else if (newType === 'string') {
					// Replace with new string
					result[key] = newValue;
				} else if (newType === 'object' && existingType === 'object') {
					if (Array.isArray(newValue) && Array.isArray(existingValue)) {
						// Concatenate arrays
						result[key] = [...existingValue, ...newValue];
					} else if (!Array.isArray(newValue) && !Array.isArray(existingValue)) {
						// Merge objects (shallow merge with overwrites)
						result[key] = { ...existingValue, ...newValue };
					} else {
						// Type mismatch, replace
						result[key] = newValue;
					}
				} else {
					// For all other cases, replace
					result[key] = newValue;
				}
			}
		}

		return result;
	}

	/**
	 * Clears the auto-flush timer for a specific event
	 * @param {string} eventKey - The event key
	 */
	function clearFlushTimer(eventKey) {
		if (flushTimers.has(eventKey)) {
			clearTimeout(flushTimers.get(eventKey));
			flushTimers.delete(eventKey);
			log('Cleared flush timer for', eventKey);
		}
	}

	/**
	 * Sets up auto-flush timer for a specific event
	 * @param {string} eventKey - The event key
	 */
	function setupFlushTimer(eventKey) {
		clearFlushTimer(eventKey);

		const timerId = setTimeout(() => {
			log('Auto-flushing due to maxBufferTime for', eventKey);
			flushEvent(eventKey, false, 'maxBufferTime');
		}, config.maxBufferTime);

		flushTimers.set(eventKey, timerId);
	}

	/**
	 * Checks if event should be auto-flushed based on limits
	 * @param {Object} eventData - The event data
	 * @returns {string|null} The reason for flushing or null
	 */
	function checkFlushLimits(eventData) {
		const { props } = eventData;

		// Check property count
		const propCount = Object.keys(props).length;
		if (propCount >= config.maxPropsCount) {
			return 'maxPropsCount';
		}

		// Check aggregated numeric values
		for (const [key, value] of Object.entries(props)) {
			if (typeof value === 'number' && Math.abs(value) >= config.maxAggregatedValue) {
				return 'maxAggregatedValue';
			}
		}

		return null;
	}

	/**
	 * Flushes a single event
	 * @param {string} eventKey - The event key to flush
	 * @param {boolean} [useSendBeacon=false] - Whether to use sendBeacon transport
	 * @param {string} [reason='manual'] - The reason for flushing
	 */
	function flushEvent(eventKey, useSendBeacon = false, reason = 'manual') {
		const eventData = eventStore.get(eventKey);
		if (!eventData) return;

		const { eventName, contentId, props } = eventData;
		const trackingProps = { contentId, ...props };

		// Clear any pending timers
		clearFlushTimer(eventKey);

		// Prepare transport options
		const transportOptions = useSendBeacon ? { transport: 'sendBeacon' } : {};

		try {
			mixpanelInstance.track(eventName, trackingProps, transportOptions);
			log('Flushed event', eventKey, 'reason:', reason, 'props:', trackingProps);

			// Call onFlush callback if provided
			if (config.onFlush && typeof config.onFlush === 'function') {
				config.onFlush({
					eventName,
					contentId,
					props: trackingProps,
					reason,
					transport: useSendBeacon ? 'sendBeacon' : 'xhr'
				});
			}
		} catch (error) {
			console.error('[Mixpanel Heartbeat] Error flushing event:', error);
		}

		// Remove from store after flushing
		eventStore.delete(eventKey);
	}

	/**
	 * Flushes all events
	 * @param {boolean} [useSendBeacon=false] - Whether to use sendBeacon transport
	 * @param {string} [reason='manual'] - The reason for flushing
	 */
	function flushAll(useSendBeacon = false, reason = 'manual') {
		const keys = Array.from(eventStore.keys());
		log('Flushing all events, count:', keys.length, 'reason:', reason);
		keys.forEach(key => flushEvent(key, useSendBeacon, reason));
	}

	/**
	 * Flushes events by content ID
	 * @param {string} contentId - The content ID to flush
	 * @param {boolean} [useSendBeacon=false] - Whether to use sendBeacon transport
	 * @param {string} [reason='manual'] - The reason for flushing
	 */
	function flushByContentId(contentId, useSendBeacon = false, reason = 'manual') {
		const keysToFlush = Array.from(eventStore.keys()).filter(key => {
			const [, storedContentId] = key.split('|');
			return storedContentId === contentId;
		});

		log('Flushing by contentId', contentId, 'count:', keysToFlush.length, 'reason:', reason);
		keysToFlush.forEach(key => flushEvent(key, useSendBeacon, reason));
	}

	/**
	 * Main heartbeat function for tracking events
	 * @param {string} eventName - The name of the event to track
	 * @param {string} contentId - Unique identifier for the content
	 * @param {Object} [props={}] - Properties to aggregate
	 * @param {Object} [options={}] - Call-specific options
	 * @param {boolean} [options.forceFlush=false] - Force immediate flush after aggregation
	 * @param {string} [options.transport] - Transport method ('xhr' or 'sendBeacon')
	 * @returns {Object} The heartbeat API object for chaining
	 */
	function heartbeat(eventName, contentId, props = {}, options = {}) {
		// Set up unload handlers on first use
		setupUnloadHandlers();

		// If called with no parameters, flush all events
		if (arguments.length === 0) {
			flushAll(false, 'manualFlushCall');
			return heartbeatAPI;
		}

		// Validate required parameters
		if (!eventName || !contentId) {
			console.warn('[Mixpanel Heartbeat] eventName and contentId are required');
			return heartbeatAPI;
		}

		const eventKey = `${eventName}|${contentId}`;

		log('Heartbeat called for', eventKey, 'props:', props);

		// Check if this is a new contentId for this eventName
		// If so, flush any existing events for this eventName with different contentIds
		const existingKeysForEvent = Array.from(eventStore.keys()).filter(key => {
			const [storedEventName, storedContentId] = key.split('|');
			return storedEventName === eventName && storedContentId !== contentId;
		});

		if (existingKeysForEvent.length > 0) {
			log('Content switch detected, flushing previous content');
			existingKeysForEvent.forEach(key => flushEvent(key, false, 'contentSwitch'));
		}

		// Get or create event data
		if (eventStore.has(eventKey)) {
			// Aggregate with existing data
			const existingData = eventStore.get(eventKey);
			const aggregatedProps = aggregateProps(existingData.props, props);

			eventStore.set(eventKey, {
				eventName,
				contentId,
				props: aggregatedProps
			});

			log('Aggregated props for', eventKey, 'new props:', aggregatedProps);
		} else {
			// Create new entry
			eventStore.set(eventKey, {
				eventName,
				contentId,
				props: { ...props }
			});

			log('Created new event entry for', eventKey);
		}

		const updatedEventData = eventStore.get(eventKey);

		// Check if we should auto-flush based on limits
		const flushReason = checkFlushLimits(updatedEventData);
		if (flushReason) {
			log('Auto-flushing due to limit:', flushReason);
			flushEvent(eventKey, options.transport === 'sendBeacon', flushReason);
		} else if (options.forceFlush) {
			log('Force flushing requested');
			flushEvent(eventKey, options.transport === 'sendBeacon', 'forceFlush');
		} else {
			// Set up or reset the auto-flush timer
			setupFlushTimer(eventKey);
		}

		return heartbeatAPI;
	}

	// API object with additional methods
	const heartbeatAPI = Object.assign(heartbeat, {
		/**
		 * Flushes events manually
		 * @param {string} [eventName] - Specific event name to flush
		 * @param {string} [contentId] - Specific content ID to flush
		 * @param {Object} [options={}] - Flush options
		 * @param {string} [options.transport] - Transport method ('xhr' or 'sendBeacon')
		 * @returns {Object} The heartbeat API object for chaining
		 */
		flush: function (eventName, contentId, options = {}) {
			const useSendBeacon = options.transport === 'sendBeacon';

			if (eventName && contentId) {
				// Flush specific event
				const eventKey = `${eventName}|${contentId}`;
				flushEvent(eventKey, useSendBeacon, 'manualFlush');
			} else if (eventName) {
				// Flush all events with this eventName
				const keysToFlush = Array.from(eventStore.keys()).filter(key =>
					key.startsWith(`${eventName}|`)
				);
				keysToFlush.forEach(key => flushEvent(key, useSendBeacon, 'manualFlush'));
			} else {
				// Flush all events
				flushAll(useSendBeacon, 'manualFlush');
			}
			return heartbeatAPI;
		},

		/**
		 * Flushes all events for a specific content ID
		 * @param {string} contentId - The content ID to flush
		 * @param {Object} [options={}] - Flush options
		 * @param {string} [options.transport] - Transport method ('xhr' or 'sendBeacon')
		 * @returns {Object} The heartbeat API object for chaining
		 */
		flushByContentId: function (contentId, options = {}) {
			const useSendBeacon = options.transport === 'sendBeacon';
			flushByContentId(contentId, useSendBeacon, 'manualFlushByContentId');
			return heartbeatAPI;
		},

		/**
		 * Gets the current state of all stored events (for debugging)
		 * @returns {Object} Current event state
		 */
		getState: function () {
			const state = {};
			eventStore.forEach((value, key) => {
				state[key] = { ...value };
			});
			return state;
		},

		/**
		 * Clears all stored events without flushing
		 * @returns {Object} The heartbeat API object for chaining
		 */
		clear: function () {
			// Clear all timers
			flushTimers.forEach(timerId => clearTimeout(timerId));
			flushTimers.clear();

			eventStore.clear();
			log('Cleared all events and timers');
			return heartbeatAPI;
		},

		/**
		 * Gets the current configuration
		 * @returns {Object} Current configuration
		 */
		getConfig: function () {
			return { ...config };
		},

		/**
		 * Updates configuration (partial updates allowed)
		 * @param {Object} newConfig - New configuration options
		 * @returns {Object} The heartbeat API object for chaining
		 */
		configure: function (newConfig) {
			Object.assign(config, newConfig);
			log('Configuration updated:', config);
			return heartbeatAPI;
		}
	});

	return heartbeatAPI;
}