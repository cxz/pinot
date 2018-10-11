/**
 * Copyright (C) 2014-2018 LinkedIn Corp. (pinot-core@linkedin.com)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *         http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.linkedin.pinot.core.realtime.stream;

import com.linkedin.pinot.common.metrics.ServerMetrics;
import com.linkedin.pinot.core.data.GenericRow;
import com.linkedin.pinot.core.realtime.StreamProviderConfig;


public interface StreamLevelConsumer {
  /**
   *
   */
  void init(StreamProviderConfig streamProviderConfig, ServerMetrics serverMetrics) throws Exception;

  /**
   *
   */
  void start() throws Exception;

  /**
   *
   * @param offset
   */
  void setOffset(long offset);

  /**
   * return GenericRow
   */
  GenericRow nextDecoded(GenericRow destination);

  /**
   *
   * @param offset
   * @return
   */
  GenericRow nextDecoded(long offset);

  /**
   *
   * @return
   */
  long currentOffset();

  /**
   *
   */
  void commit();

  /**
   *
   * @param offset
   */
  void commit(long offset);

  /**
   *
   */
  void shutdown() throws Exception;
}
