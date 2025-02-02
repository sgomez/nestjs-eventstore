import {
  END,
  ErrorType,
  EventStoreDBClient,
  FORWARDS,
  jsonEvent,
  JSONType,
  NO_STREAM,
  ResolvedEvent,
  START,
} from '@eventstore/db-client';
import { Inject, Injectable, Logger, Type } from '@nestjs/common';
import { IEventPublisher, IMessageSource } from '@nestjs/cqrs';
import { Subject } from 'rxjs';
import { v4 as uuid } from 'uuid';

import { AggregateRoot, Event } from './domain';
import { Config } from './eventstore.config';
import { EVENTSTORE_SETTINGS_TOKEN } from './eventstore.constants';
import { EventStoreMapper } from './eventstore.mapper';
import { KeyService } from './services';

@Injectable()
export class EventStore
  implements IEventPublisher<Event>, IMessageSource<Event>
{
  private category: string;
  private client: EventStoreDBClient;
  private readonly logger = new Logger(EventStore.name);

  constructor(
    @Inject(EVENTSTORE_SETTINGS_TOKEN) private readonly config: Config,
    private readonly mapper: EventStoreMapper,
    private readonly keyService: KeyService,
  ) {
    this.category = config.category;
    this.client = EventStoreDBClient.connectionString(config.connection);
  }

  async publish<T extends Event>(event: T) {
    const streamName = `${this.category}-${event.aggregateId}`;
    const expectedRevision =
      event.version <= 0 ? NO_STREAM : BigInt(event.version - 1);

    if (event.aggregateEncrypted) {
      event = (await this.keyService.encryptEvent(event)) as T;
    }

    const eventData = jsonEvent({
      id: uuid(),
      type: event.eventType,
      data: event.payload as JSONType,
      metadata: event.metadata,
    });

    try {
      await this.client.appendToStream(streamName, eventData, {
        expectedRevision: expectedRevision,
      });
    } catch (e) {
      console.debug('error', e);
    }
  }

  async read<T extends AggregateRoot>(
    aggregate: Type<T>,
    id: string,
  ): Promise<T> | null {
    const streamName = `${this.category}-${id}`;

    try {
      const entity = <T>Reflect.construct(aggregate, []);
      const resolvedEvents = await this.client.readStream(streamName, {
        direction: FORWARDS,
        fromRevision: START,
      });

      const events = await Promise.all(
        resolvedEvents.map<Promise<Event>>((event) =>
          this.mapper.resolvedEventToDomainEvent(event),
        ),
      );

      entity.loadFromHistory(events);

      return entity;
    } catch (error) {
      if (error?.type === ErrorType.STREAM_NOT_FOUND) {
        return null;
      }

      this.logger.debug(error);
    }

    return null;
  }

  async bridgeEventsTo<T extends Event>(subject: Subject<T>) {
    const streamName = `$ce-${this.category}`;

    const onEvent = async (resolvedEvent: ResolvedEvent) => {
      subject.next(
        <T>await this.mapper.resolvedEventToDomainEvent(resolvedEvent),
      );
    };

    try {
      await this.client
        .subscribeToStream(streamName, {
          fromRevision: END,
          resolveLinkTos: true,
        })
        .on('data', onEvent);
    } catch (error) {
      this.logger.debug(error);
    }
  }
}
