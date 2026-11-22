# Inertia CAD Bridge for SketchUp.
#
# A loopback TCP server that Inertia connects to. Every request runs on
# SketchUp's main thread from a UI timer, carries the per-session token from the
# discovery file, and uses one JSON object per line. Reads never change the
# model. Edits are re-validated against the preview's fingerprints and applied
# as one undoable operation.
# There is deliberately no way to run arbitrary Ruby through this bridge.
require 'socket'
require 'json'
require 'securerandom'
require 'fileutils'
require 'digest'
require 'base64'
require 'tmpdir'

module Inertia
  module CadBridge
    BRIDGE_VERSION = '1.2.0'.freeze
    PROTOCOL = 1
    MAX_REQUEST_BYTES = 1024 * 1024
    MM_PER_INCH = 25.4
    DEFAULT_LIMIT = 100
    MAX_LIMIT = 500
    MAX_VISITS = 50_000
    MAX_OPERATIONS = 50
    MAX_TARGETS = 500
    MAX_COORDINATE_MM = 1.0e7
    MAX_INFO_ITEMS = 500
    MAX_CLIENTS = 8
    IDLE_SECONDS = 10
    LENGTH_UNITS = { 0 => 'in', 1 => 'ft', 2 => 'mm', 3 => 'cm', 4 => 'm', 5 => 'yd' }.freeze
    QUERY_TYPES = %w[group component face edge text dimension image guide section_plane].freeze
    AUTOCAD_ONLY_FILTERS = %w[layer layout textContains].freeze

    class BridgeError < StandardError
      attr_reader :code

      def initialize(code, message)
        super(message)
        @code = code
      end
    end

    @models = {}
    @revisions = {}

    class << self
      attr_reader :port, :token
    end

    def self.fail!(code, message)
      raise BridgeError.new(code, message)
    end

    # --- Documents -------------------------------------------------------

    def self.model_alive?(model)
      return false if model.nil?
      model.respond_to?(:valid?) ? model.valid? : true
    rescue StandardError
      false
    end

    def self.open_models
      list = []
      # SketchUp 2027 can hold several models in one process. Use its list when
      # this build has one; otherwise the active model is the only one we see.
      if Sketchup.respond_to?(:models)
        begin
          Sketchup.models.each { |model| list << model }
        rescue StandardError
          list = []
        end
      end
      active = Sketchup.active_model
      list << active if active && list.none? { |model| model == active }
      list.select { |model| model_alive?(model) }
    end

    def self.model_id(model)
      @models.each { |id, known| return id if known == model }
      id = "skp:#{Process.pid}:#{SecureRandom.hex(4)}"
      @models[id] = model
      @revisions[id] = 0
      begin
        model.add_observer(RevisionObserver.new(id))
      rescue StandardError
        nil
      end
      id
    end

    def self.bump(id)
      @revisions[id] = (@revisions[id] || 0) + 1
    end

    def self.revision(id)
      @revisions[id] || 0
    end

    def self.display_units(model)
      LENGTH_UNITS[model.options['UnitsOptions']['LengthUnit']] || 'in'
    rescue StandardError
      'in'
    end

    def self.describe_model(model, active)
      id = model_id(model)
      title = model.title.to_s
      path = model.path.to_s
      {
        'documentId' => id,
        'app' => 'sketchup',
        'name' => title.empty? ? 'Untitled' : title,
        'path' => path.empty? ? nil : path,
        'modified' => model.respond_to?(:modified?) ? model.modified? : nil,
        'active' => model == active,
        'revision' => revision(id),
        'displayUnits' => display_units(model)
      }
    end

    def self.documents(_params)
      active = Sketchup.active_model
      { 'documents' => open_models.map { |model| describe_model(model, active) } }
    end

    def self.model_for(document_id, require_active = false)
      model = @models[document_id.to_s]
      unless model_alive?(model)
        fail!('DOCUMENT_NOT_FOUND', 'That SketchUp model is no longer open. Call inertia_cad_status for current documents.')
      end
      if require_active && model != Sketchup.active_model
        fail!('INACTIVE_DOCUMENT', 'Bring this model to the front in SketchUp, then try again.')
      end
      model
    end

    # --- Entities --------------------------------------------------------

    def self.type_name(entity)
      case entity
      when Sketchup::ComponentInstance then 'component'
      when Sketchup::Group then 'group'
      when Sketchup::Face then 'face'
      when Sketchup::Edge then 'edge'
      when Sketchup::Text then 'text'
      when Sketchup::Dimension then 'dimension'
      when Sketchup::Image then 'image'
      when Sketchup::ConstructionLine, Sketchup::ConstructionPoint then 'guide'
      when Sketchup::SectionPlane then 'section_plane'
      else entity.class.name.to_s.split('::').last.to_s.downcase
      end
    end

    def self.container?(entity)
      entity.is_a?(Sketchup::Group) || entity.is_a?(Sketchup::ComponentInstance)
    end

    def self.tag_label(layer)
      return nil if layer.nil?
      layer.respond_to?(:display_name) ? layer.display_name : layer.name
    end

    def self.find_tag(model, name)
      model.layers.find { |layer| layer.name == name || tag_label(layer) == name }
    end

    def self.find_material(model, name)
      model.materials.find do |material|
        material.name == name || (material.respond_to?(:display_name) && material.display_name == name)
      end
    end

    def self.material_label(material)
      return nil if material.nil?
      material.respond_to?(:display_name) ? material.display_name : material.name
    end

    # True when the entity appears exactly once in the model, so an edit to it
    # cannot leak into other copies of a component or copied group.
    def self.unshared?(entity)
      parent = entity.parent
      guard = 0
      while parent.is_a?(Sketchup::ComponentDefinition)
        return false if parent.instances.size != 1 || guard > 64
        instance = parent.instances.first
        parent = instance.parent
        guard += 1
      end
      true
    end

    def self.locked_chain?(entity)
      return true if entity.respond_to?(:locked?) && entity.locked?
      parent = entity.parent
      guard = 0
      while parent.is_a?(Sketchup::ComponentDefinition) && guard <= 64
        instance = parent.instances.first
        break if instance.nil?
        return true if instance.respond_to?(:locked?) && instance.locked?
        parent = instance.parent
        guard += 1
      end
      false
    end

    # World transformation of the entity's parent context, along its first
    # occurrence. Exact whenever the entity is unshared.
    def self.parent_transform(entity)
      transform = Geom::Transformation.new
      parent = entity.parent
      guard = 0
      while parent.is_a?(Sketchup::ComponentDefinition) && guard <= 64
        instance = parent.instances.first
        break if instance.nil?
        transform = instance.transformation * transform
        parent = instance.parent
        guard += 1
      end
      transform
    end

    def self.mm(value)
      (value.to_f * MM_PER_INCH).round(2)
    end

    def self.bounds_mm(bounds, transform)
      return nil if bounds.nil? || bounds.empty?
      points = (0..7).map { |index| bounds.corner(index).transform(transform) }
      {
        'min' => [mm(points.map(&:x).min), mm(points.map(&:y).min), mm(points.map(&:z).min)],
        'max' => [mm(points.map(&:x).max), mm(points.map(&:y).max), mm(points.map(&:z).max)]
      }
    end

    def self.summarize(entity, transform, depth = nil, compact = false)
      row = { 'id' => entity.persistent_id.to_s, 'type' => type_name(entity) }
      if compact
        row['tag'] = tag_label(entity.layer) if entity.respond_to?(:layer)
        bounds = bounds_mm(entity.bounds, transform)
        row['boundsMm'] = bounds if bounds
        return row
      end
      if container?(entity)
        row['name'] = entity.name.to_s
        row['definition'] = entity.definition.name.to_s
        row['children'] = entity.definition.entities.size
      end
      row['tag'] = tag_label(entity.layer) if entity.respond_to?(:layer)
      material = entity.respond_to?(:material) ? entity.material : nil
      row['material'] = material_label(material) if material
      row['text'] = entity.text.to_s[0, 500] if entity.is_a?(Sketchup::Text)
      # Measured in world space, like boundsMm, so scaled groups report true sizes.
      row['areaMm2'] = (entity.area(transform) * MM_PER_INCH * MM_PER_INCH).round(1) if entity.is_a?(Sketchup::Face)
      if entity.is_a?(Sketchup::Edge)
        row['lengthMm'] = mm(entity.start.position.transform(transform).distance(entity.end.position.transform(transform)))
      end
      row['hidden'] = true if entity.respond_to?(:hidden?) && entity.hidden?
      row['locked'] = true if entity.respond_to?(:locked?) && entity.locked?
      row['shared'] = true unless unshared?(entity)
      row['depth'] = depth unless depth.nil?
      bounds = bounds_mm(entity.bounds, transform)
      row['boundsMm'] = bounds if bounds
      row
    end

    def self.limit_param(params)
      value = params['limit'].to_i
      value = DEFAULT_LIMIT if value <= 0
      [value, MAX_LIMIT].min
    end

    def self.selection(params)
      model = model_for(params['documentId'])
      id = model_id(model)
      limit = limit_param(params)
      selected = model.selection.to_a
      transform = model.respond_to?(:edit_transform) ? model.edit_transform : Geom::Transformation.new
      active_path = model.active_path || []
      {
        'documentId' => id,
        'revision' => revision(id),
        'units' => 'mm',
        'total' => selected.size,
        'truncated' => selected.size > limit,
        'editingInside' => active_path.map { |instance| instance.persistent_id.to_s },
        'items' => selected.first(limit).map { |entity| summarize(entity, transform) }
      }
    end

    def self.walk(entities, transform, depth, max_depth, state, &visit)
      entities.each do |entity|
        if state[:visits] >= MAX_VISITS
          state[:capped] = true
          return
        end
        state[:visits] += 1
        visit.call(entity, transform, depth)
        next unless depth < max_depth && container?(entity)
        walk(entity.definition.entities, transform * entity.transformation, depth + 1, max_depth, state, &visit)
        return if state[:capped]
      end
    end

    # A plan-view rectangle in millimetres: crossing keeps anything that touches it, window only
    # what lies fully inside.
    def self.within_param(value)
      return nil if value.nil?
      message = 'within needs min and max as [x, y] in millimetres, with min below max.'
      fail!('INVALID_REQUEST', message) unless value.is_a?(Hash)
      corners = [value['min'], value['max']]
      unless corners.all? { |corner| corner.is_a?(Array) && corner.size == 2 && corner.all? { |v| v.is_a?(Numeric) && v.to_f.finite? } }
        fail!('INVALID_REQUEST', message)
      end
      min, max = corners.map { |corner| corner.map(&:to_f) }
      fail!('INVALID_REQUEST', message) if min[0] > max[0] || min[1] > max[1]
      mode = (value['mode'] || 'crossing').to_s
      fail!('INVALID_REQUEST', 'within.mode must be crossing or window.') unless %w[crossing window].include?(mode)
      { min: min, max: max, window: mode == 'window' }
    end

    def self.in_area?(bounds, area)
      return false if bounds.nil?
      low = bounds['min']
      high = bounds['max']
      if area[:window]
        low[0] >= area[:min][0] && low[1] >= area[:min][1] && high[0] <= area[:max][0] && high[1] <= area[:max][1]
      else
        high[0] >= area[:min][0] && low[0] <= area[:max][0] && high[1] >= area[:min][1] && low[1] <= area[:max][1]
      end
    end

    def self.query(params)
      model = model_for(params['documentId'])
      id = model_id(model)
      foreign = AUTOCAD_ONLY_FILTERS.reject { |key| params[key].nil? }
      unless foreign.empty?
        fail!('INVALID_REQUEST', "#{foreign.join(', ')} only work in AutoCAD. In SketchUp, filter by tag, nameContains, or types.")
      end
      fields = (params['fields'] || 'full').to_s
      fail!('INVALID_REQUEST', 'fields must be full or compact.') unless %w[full compact].include?(fields)
      area = within_param(params['within'])
      types = Array(params['types']).map(&:to_s)
      types = %w[group component] if types.empty?
      unknown = types - QUERY_TYPES
      fail!('INVALID_REQUEST', "Unknown types: #{unknown.join(', ')}. Use #{QUERY_TYPES.join(', ')}.") unless unknown.empty?
      tag = params['tag'] && params['tag'].to_s
      needle = params['nameContains'] && params['nameContains'].to_s.downcase
      max_depth = params['maxDepth'].nil? ? 8 : [[params['maxDepth'].to_i, 0].max, 32].min
      offset = [params['cursor'].to_i, 0].max
      limit = limit_param(params)
      counts = Hash.new(0)
      matches = []
      state = { visits: 0, capped: false }
      walk(model.entities, Geom::Transformation.new, 0, max_depth, state) do |entity, transform, depth|
        kind = type_name(entity)
        counts[kind] += 1
        next unless types.include?(kind)
        next if tag && tag_label(entity.respond_to?(:layer) ? entity.layer : nil) != tag
        if needle
          names = [entity.respond_to?(:name) ? entity.name.to_s : '']
          names << entity.definition.name.to_s if container?(entity)
          next unless names.any? { |name| name.downcase.include?(needle) }
        end
        next if area && !in_area?(bounds_mm(entity.bounds, transform), area)
        matches << [entity, transform, depth]
      end
      page = matches[offset, limit] || []
      result = {
        'documentId' => id,
        'revision' => revision(id),
        'units' => 'mm',
        'total' => matches.size,
        'counts' => counts,
        'items' => page.map { |entity, transform, depth| summarize(entity, transform, depth, fields == 'compact') }
      }
      result['nextCursor'] = (offset + limit).to_s if offset + limit < matches.size
      result['scanCapped'] = true if state[:capped]
      result
    end

    def self.capped(result, key, items)
      result[key] = items.first(MAX_INFO_ITEMS)
      result["#{key}Truncated"] = true if items.size > MAX_INFO_ITEMS
    end

    def self.info(params)
      model = model_for(params['documentId'])
      id = model_id(model)
      result = {
        'documentId' => id,
        'revision' => revision(id),
        'units' => 'mm',
        'displayUnits' => display_units(model),
        'boundsMm' => bounds_mm(model.bounds, Geom::Transformation.new),
        'entityCount' => model.entities.size
      }
      capped(result, 'tags', model.layers.map { |layer| { 'name' => tag_label(layer), 'visible' => layer.visible? } })
      capped(result, 'materials', model.materials.map { |material| material_label(material) })
      capped(result, 'scenes', model.pages.map { |page| page.name.to_s })
      definitions = model.definitions.reject { |definition| definition.group? || definition.image? }
      capped(result, 'componentDefinitions',
             definitions.map { |definition| { 'name' => definition.name.to_s, 'instances' => definition.instances.size } })
      result
    end

    def self.capture(params)
      model = model_for(params['documentId'], true)
      id = model_id(model)
      view = model.active_view
      max_width = [[params['maxWidth'].to_i, 64].max, 2048].min
      max_height = [[params['maxHeight'].to_i, 64].max, 2048].min
      scale = [max_width.to_f / view.vpwidth, max_height.to_f / view.vpheight, 1.0].min
      width = [(view.vpwidth * scale).round, 1].max
      height = [(view.vpheight * scale).round, 1].max
      path = File.join(Dir.tmpdir, "inertia-cad-#{SecureRandom.hex(6)}.png")
      begin
        written = view.write_image(filename: path, width: width, height: height, antialias: true, transparent: false)
        fail!('CAPTURE_FAILED', 'SketchUp could not export the view.') unless written && File.exist?(path)
        data = Base64.strict_encode64(File.binread(path))
      ensure
        File.delete(path) if File.exist?(path)
      end
      page = model.pages.respond_to?(:selected_page) ? model.pages.selected_page : nil
      {
        'documentId' => id,
        'revision' => revision(id),
        'width' => width,
        'height' => height,
        'pngBase64' => data,
        'scene' => page ? page.name : nil
      }
    end

    # --- Edits -----------------------------------------------------------

    def self.entity_for(model, raw_id)
      pid = Integer(raw_id.to_s, 10)
      entity = model.find_entity_by_persistent_id(pid)
      unless entity && entity.valid?
        fail!('TARGET_NOT_FOUND', "Nothing with id #{raw_id} is in this model any more. Read the selection again.")
      end
      entity
    rescue ArgumentError
      fail!('INVALID_REQUEST', "#{raw_id.inspect} is not a SketchUp entity id.")
    end

    def self.label(entity)
      name = container?(entity) ? entity.name.to_s : ''
      name = entity.definition.name.to_s if name.empty? && container?(entity)
      name.empty? ? "#{type_name(entity)} #{entity.persistent_id}" : "#{type_name(entity)} \"#{name}\" (#{entity.persistent_id})"
    end

    def self.writable!(entity)
      fail!('UNSUPPORTED_TARGET', "#{label(entity)} cannot be edited through Inertia.") unless entity.is_a?(Sketchup::Drawingelement)
      unless unshared?(entity)
        fail!('SHARED_DEFINITION',
              "#{label(entity)} sits inside a component or group that appears more than once, so this edit " \
              'would change every copy. Pick a top-level object, or make that component unique in SketchUp first.')
      end
      fail!('LOCKED', "#{label(entity)} is locked (or inside a locked group). Unlock it in SketchUp first.") if locked_chain?(entity)
    end

    def self.fingerprint(entity)
      parts = [type_name(entity), entity.persistent_id]
      parts << entity.name.to_s << entity.definition.name.to_s << entity.transformation.to_a.map { |v| v.round(6) } if container?(entity)
      parts << entity.layer.name if entity.respond_to?(:layer)
      material = entity.respond_to?(:material) ? entity.material : nil
      parts << (material ? material.name : '')
      parts << (entity.respond_to?(:hidden?) && entity.hidden?)
      bounds = entity.bounds
      parts << [bounds.min.to_a, bounds.max.to_a].flatten.map { |v| v.to_f.round(6) } unless bounds.empty?
      parts << contents_digest(entity.definition) if container?(entity)
      Digest::SHA256.hexdigest(parts.join('|'))[0, 16]
    end

    # A container's direct contents, so an edit inside a group after the preview
    # makes the preview stale. Capped so huge definitions stay cheap.
    def self.contents_digest(definition)
      entities = definition.entities
      rows = entities.first(2000).map do |child|
        child_bounds = child.bounds
        material = child.respond_to?(:material) ? child.material : nil
        [
          child.persistent_id, type_name(child),
          child.respond_to?(:layer) ? child.layer.name : '', material ? material.name : '',
          child_bounds.empty? ? '' : [child_bounds.min.to_a, child_bounds.max.to_a].flatten.map { |v| v.to_f.round(6) }
        ].join(',')
      end
      "#{entities.size}:#{Digest::SHA256.hexdigest(rows.join(';'))[0, 16]}"
    end

    def self.vector_param(value, name)
      unless value.is_a?(Array) && value.size == 3 && value.all? { |v| v.is_a?(Numeric) && v.to_f.finite? && v.abs <= MAX_COORDINATE_MM }
        fail!('INVALID_REQUEST', "#{name} must be [x, y, z] in millimetres.")
      end
      value.map(&:to_f)
    end

    def self.ids_param(op)
      ids = Array(op['ids'])
      ids = [op['id']] if ids.empty? && op['id']
      fail!('INVALID_REQUEST', "#{op['op']} needs at least one id.") if ids.empty?
      fail!('INVALID_REQUEST', "#{op['op']} accepts at most #{MAX_TARGETS} ids.") if ids.size > MAX_TARGETS
      ids
    end

    def self.name_param(value, what)
      name = value.to_s.strip
      fail!('INVALID_REQUEST', "#{what} needs a name.") if name.empty? || name.size > 200
      name
    end

    # Resolves and checks every operation without touching the model. Returns
    # what the designer will see, fingerprints of everything the edit depends
    # on, and the steps that perform it.
    def self.plan(model, operations)
      operations = Array(operations)
      fail!('INVALID_REQUEST', 'Give at least one operation.') if operations.empty?
      fail!('INVALID_REQUEST', "At most #{MAX_OPERATIONS} operations per change.") if operations.size > MAX_OPERATIONS
      changes = []
      fingerprints = {}
      steps = []
      new_tags = {}
      new_materials = {}
      warnings = []
      # Tags as earlier operations in this batch leave them, so a later one is never skipped as a no-op.
      projected_tags = {}
      target = lambda do |raw_id|
        entity = entity_for(model, raw_id)
        writable!(entity)
        fingerprints["entity:#{entity.persistent_id}"] = fingerprint(entity)
        entity
      end
      operations.each do |op|
        kind = op['op'].to_s
        case kind
        when 'skp.create_tag'
          name = name_param(op['name'], kind)
          fail!('ALREADY_EXISTS', "Tag \"#{name}\" already exists.") if find_tag(model, name) || new_tags[name]
          new_tags[name] = true
          fingerprints["tag:#{name}"] = 'absent'
          changes << { 'op' => kind, 'target' => name, 'field' => 'tag', 'before' => nil, 'after' => 'created' }
          steps << ->(_created) { model.layers.add(name) }
        when 'skp.create_material'
          name = name_param(op['name'], kind)
          color = op['color'].to_s
          fail!('INVALID_REQUEST', 'color must look like #RRGGBB.') unless color =~ /\A#\h{6}\z/
          alpha = op['alpha'].nil? ? nil : op['alpha'].to_f
          fail!('INVALID_REQUEST', 'alpha must be between 0 and 1.') if alpha && !(alpha >= 0 && alpha <= 1)
          fail!('ALREADY_EXISTS', "Material \"#{name}\" already exists.") if find_material(model, name) || new_materials[name]
          new_materials[name] = true
          fingerprints["material:#{name}"] = 'absent'
          changes << { 'op' => kind, 'target' => name, 'field' => 'material', 'before' => nil, 'after' => color }
          steps << lambda do |_created|
            material = model.materials.add(name)
            material.color = Sketchup::Color.new(color[1, 2].hex, color[3, 2].hex, color[5, 2].hex)
            material.alpha = alpha if alpha
          end
        when 'skp.set_tag'
          name = name_param(op['tag'], kind)
          fail!('TAG_NOT_FOUND', "No tag named \"#{name}\". Create it first with skp.create_tag.") unless find_tag(model, name) || new_tags[name]
          ids_param(op).each do |raw_id|
            entity = target.call(raw_id)
            existing = find_tag(model, name)
            after = existing ? tag_label(existing) : name
            before = projected_tags.fetch(entity.persistent_id) { tag_label(entity.layer) }
            if before == after
              warnings << "#{label(entity)} already has tag #{after}."
              next
            end
            projected_tags[entity.persistent_id] = after
            changes << { 'op' => kind, 'target' => label(entity), 'field' => 'tag', 'before' => before, 'after' => after }
            steps << ->(_created) { entity.layer = find_tag(model, name) }
          end
        when 'skp.set_material'
          name = name_param(op['material'], kind)
          unless find_material(model, name) || new_materials[name]
            fail!('MATERIAL_NOT_FOUND', "No material named \"#{name}\" in this model. Create it with skp.create_material.")
          end
          ids_param(op).each do |raw_id|
            entity = target.call(raw_id)
            before = material_label(entity.material)
            changes << { 'op' => kind, 'target' => label(entity), 'field' => 'material', 'before' => before, 'after' => name }
            steps << ->(_created) { entity.material = find_material(model, name) }
          end
        when 'skp.rename'
          name = op['name'].to_s.strip
          fail!('INVALID_REQUEST', 'name must be at most 200 characters.') if name.size > 200
          ids_param(op).each do |raw_id|
            entity = target.call(raw_id)
            fail!('UNSUPPORTED_TARGET', "Only groups and components have names; #{label(entity)} does not.") unless container?(entity)
            changes << { 'op' => kind, 'target' => label(entity), 'field' => 'name', 'before' => entity.name.to_s, 'after' => name }
            steps << ->(_created) { entity.name = name }
          end
        when 'skp.move'
          vector_mm = vector_param(op['vectorMm'], 'vectorMm')
          world = Geom::Vector3d.new(*vector_mm.map { |v| v / MM_PER_INCH })
          ids_param(op).each do |raw_id|
            entity = target.call(raw_id)
            fail!('UNSUPPORTED_TARGET', "Only groups and components can be moved; #{label(entity)} cannot.") unless container?(entity)
            local = world.transform(parent_transform(entity).inverse)
            changes << { 'op' => kind, 'target' => label(entity), 'field' => 'position', 'before' => nil, 'after' => "moved by #{vector_mm.join(', ')} mm" }
            steps << ->(_created) { entity.transform!(Geom::Transformation.translation(local)) }
          end
        when 'skp.set_hidden'
          hidden = op['hidden'] == true
          ids_param(op).each do |raw_id|
            entity = target.call(raw_id)
            changes << { 'op' => kind, 'target' => label(entity), 'field' => 'hidden', 'before' => entity.hidden?, 'after' => hidden }
            steps << ->(_created) { entity.hidden = hidden }
          end
        when 'skp.erase'
          # Erasing is the edit that loses the most; any committed change since the preview makes it stale.
          fingerprints['revision'] = revision(model_id(model)).to_s
          ids_param(op).each do |raw_id|
            entity = target.call(raw_id)
            # SketchUp deletes every face an erased edge bounds; the change row says so too.
            edge = entity.is_a?(Sketchup::Edge)
            warnings << 'Erasing an edge also deletes the faces it bounds.' if edge
            changes << {
              'op' => kind, 'target' => label(entity), 'field' => 'entity', 'before' => 'present',
              'after' => edge ? 'erased, with the faces it bounds' : 'erased'
            }
            steps << ->(_created) { entity.erase! if entity.valid? }
          end
        when 'skp.add_box'
          origin = vector_param(op['originMm'], 'originMm')
          size = vector_param(op['sizeMm'], 'sizeMm')
          fail!('INVALID_REQUEST', 'sizeMm values must all be greater than 0.') unless size.all? { |v| v > 0 }
          tag = op['tag'] && name_param(op['tag'], kind)
          fail!('TAG_NOT_FOUND', "No tag named \"#{tag}\".") if tag && !(find_tag(model, tag) || new_tags[tag])
          material = op['material'] && name_param(op['material'], kind)
          fail!('MATERIAL_NOT_FOUND', "No material named \"#{material}\".") if material && !(find_material(model, material) || new_materials[material])
          box_name = op['name'].to_s.strip
          changes << {
            'op' => kind, 'target' => box_name.empty? ? 'new box' : "new box \"#{box_name}\"", 'field' => 'geometry',
            'before' => nil, 'after' => "#{size.join(' x ')} mm at #{origin.join(', ')} mm"
          }
          steps << lambda do |created|
            x, y, z = origin.map { |v| v / MM_PER_INCH }
            w, d, h = size.map { |v| v / MM_PER_INCH }
            group = model.entities.add_group
            face = group.entities.add_face([x, y, z], [x + w, y, z], [x + w, y + d, z], [x, y + d, z])
            face.reverse! if face.normal.z < 0
            face.pushpull(h)
            group.name = box_name unless box_name.empty?
            group.layer = find_tag(model, tag) if tag
            group.material = find_material(model, material) if material
            created << { 'id' => group.persistent_id.to_s, 'type' => 'group', 'name' => box_name }
          end
        else
          fail!('UNSUPPORTED_OPERATION', "SketchUp does not support #{kind.inspect}.")
        end
      end
      { changes: changes, fingerprints: fingerprints, steps: steps, warnings: warnings.uniq }
    end

    def self.preview(params)
      model = model_for(params['documentId'])
      id = model_id(model)
      planned = plan(model, params['operations'])
      {
        'documentId' => id,
        'documentName' => model.title.to_s.empty? ? 'Untitled model' : model.title.to_s,
        'revision' => revision(id),
        'changes' => planned[:changes],
        'fingerprints' => planned[:fingerprints],
        'warnings' => planned[:warnings]
      }
    end

    def self.stale_keys(expected, actual)
      expected = expected.is_a?(Hash) ? expected : {}
      (expected.keys | actual.keys).reject { |key| expected[key] == actual[key] }
    end

    # Inertia stops reading at deadlineAt and hangs up when it gives up, so a request that waited past
    # either while SketchUp was busy must not change the model: nobody would learn that it did.
    def self.abandoned?(params)
      deadline = params['deadlineAt']
      return true if deadline.is_a?(Numeric) && Time.now.to_f * 1000 >= deadline
      client_gone?
    end

    def self.client_gone?
      return false if @current_client.nil?
      peek = @current_client.recv_nonblock(1, Socket::MSG_PEEK, exception: false)
      peek.nil? || peek == ''
    rescue IOError, SystemCallError
      true
    end

    def self.apply(params)
      model = model_for(params['documentId'], true)
      id = model_id(model)
      fail!('HOST_TIMEOUT', 'Inertia stopped waiting before SketchUp reached this edit, so nothing was changed.') if abandoned?(params)
      planned = plan(model, params['operations'])
      stale = stale_keys(params['expectedFingerprints'], planned[:fingerprints])
      unless stale.empty?
        fail!('TARGET_CHANGED', "The model changed since the preview (#{stale.first(5).join(', ')}). Preview the change again.")
      end
      # From here Inertia never retries: failures report as consumed.
      begin
        started = model.start_operation(params['title'].to_s.empty? ? 'Inertia edit' : "Inertia: #{params['title']}", true)
      rescue StandardError => error
        fail!('APPLY_FAILED', "SketchUp could not start the edit, so nothing was changed: #{error.message}")
      end
      fail!('APPLY_FAILED', 'SketchUp was busy with another operation, so nothing was changed.') unless started
      created = []
      begin
        planned[:steps].each { |step| step.call(created) }
      rescue StandardError => error
        model.abort_operation
        fail!('APPLY_FAILED', "SketchUp refused the edit, so nothing was changed: #{error.message}")
      end
      begin
        model.commit_operation
      rescue StandardError => error
        fail!('APPLY_UNCONFIRMED', "SketchUp may not have kept the edit (#{error.message}). Check the model and its undo history.")
      end
      {
        'documentId' => id,
        'status' => 'applied',
        'revision' => revision(id),
        'changes' => planned[:changes],
        'created' => created
      }
    end

    def self.save_copy(params)
      model = model_for(params['documentId'])
      path = params['path'].to_s
      fail!('INVALID_REQUEST', 'The copy must be a .skp file.') unless path =~ /\.skp\z/i
      fail!('ALREADY_EXISTS', 'A file already exists at that path. Pick a new name; copies never overwrite.') if File.exist?(path)
      fail!('INVALID_REQUEST', 'The destination folder does not exist.') unless File.directory?(File.dirname(path))
      saved = model.save_copy(path)
      fail!('SAVE_FAILED', 'SketchUp could not save the copy.') unless saved && File.exist?(path)
      {
        'documentId' => model_id(model),
        'path' => path,
        'bytes' => File.size(path),
        'originalPath' => model.path.to_s.empty? ? nil : model.path
      }
    end

    def self.hello(_params)
      {
        'app' => 'sketchup',
        'appVersion' => Sketchup.version.to_s,
        'bridgeVersion' => BRIDGE_VERSION,
        'protocol' => PROTOCOL,
        'platform' => Sketchup.respond_to?(:platform) ? Sketchup.platform.to_s : RUBY_PLATFORM
      }
    end

    METHODS = {
      'hello' => :hello,
      'documents' => :documents,
      'selection' => :selection,
      'query' => :query,
      'info' => :info,
      'capture' => :capture,
      'preview' => :preview,
      'apply' => :apply,
      'save_copy' => :save_copy
    }.freeze

    # --- Transport -------------------------------------------------------

    def self.secure_compare(left, right)
      return false unless left.bytesize == right.bytesize
      left.bytes.zip(right.bytes).inject(0) { |acc, (a, b)| acc | (a ^ b) }.zero?
    end

    def self.handle_line(line, token = @token)
      request = JSON.parse(line.dup.force_encoding(Encoding::UTF_8))
      request = {} unless request.is_a?(Hash)
      id = request['id']
      unless token && secure_compare(request['token'].to_s, token)
        return { 'v' => PROTOCOL, 'id' => id, 'ok' => false, 'error' => { 'code' => 'UNAUTHORIZED', 'message' => 'Bad bridge token.' } }
      end
      method = METHODS[request['method'].to_s]
      fail!('UNSUPPORTED_OPERATION', "Unknown bridge method #{request['method'].inspect}.") unless method
      params = request['params'].is_a?(Hash) ? request['params'] : {}
      { 'v' => PROTOCOL, 'id' => id, 'ok' => true, 'result' => send(method, params) }
    rescue BridgeError => error
      { 'v' => PROTOCOL, 'id' => id, 'ok' => false, 'error' => { 'code' => error.code, 'message' => error.message } }
    rescue JSON::ParserError
      { 'v' => PROTOCOL, 'id' => nil, 'ok' => false, 'error' => { 'code' => 'INVALID_REQUEST', 'message' => 'The request was not JSON.' } }
    rescue StandardError => error
      { 'v' => PROTOCOL, 'id' => id, 'ok' => false, 'error' => { 'code' => 'HOST_ERROR', 'message' => "#{error.class}: #{error.message}"[0, 500] } }
    end

    def self.home_dir
      profile = ENV['USERPROFILE'].to_s
      Sketchup.platform.to_s.include?('win') && !profile.empty? ? profile : Dir.home
    rescue StandardError
      Dir.home
    end

    def self.discovery_path
      File.join(home_dir, '.inertia-cad', 'hosts', "sketchup-#{Process.pid}.json")
    end

    def self.write_discovery
      path = discovery_path
      FileUtils.mkdir_p(File.dirname(path))
      payload = {
        'app' => 'sketchup', 'pid' => Process.pid, 'port' => @port, 'token' => @token,
        'bridgeVersion' => BRIDGE_VERSION, 'protocol' => PROTOCOL, 'appVersion' => Sketchup.version.to_s
      }
      temp = "#{path}.#{SecureRandom.hex(4)}.tmp"
      File.open(temp, 'w', 0o600) { |file| file.write(JSON.generate(payload)) }
      File.rename(temp, path)
    end

    def self.remove_discovery
      path = discovery_path
      File.delete(path) if File.exist?(path)
    rescue StandardError
      nil
    end

    def self.monotonic
      Process.clock_gettime(Process::CLOCK_MONOTONIC)
    end

    def self.start
      return if @server
      @token = SecureRandom.hex(32)
      @server = TCPServer.new('127.0.0.1', 0)
      @port = @server.addr[1]
      @clients = {}
      @busy = false
      write_discovery
      Sketchup.add_observer(AppObserver.new)
      @timer = UI.start_timer(0.05, true) { tick }
    rescue StandardError => error
      puts "[Inertia CAD Bridge] could not start: #{error.message}"
    end

    def self.stop
      UI.stop_timer(@timer) if @timer
      @timer = nil
      (@clients || {}).keys.each { |socket| close_client(socket) }
      @server.close if @server
      @server = nil
      remove_discovery
    end

    # A host call that spins a nested event loop can fire this timer
    # again; @busy keeps requests strictly one at a time.
    def self.tick
      return if @busy || @server.nil?
      @busy = true
      begin
        # Connections past the cap wait in the listen backlog until a slot frees.
        while @clients.size < MAX_CLIENTS
          socket = @server.accept_nonblock(exception: false)
          break unless socket.is_a?(TCPSocket) || socket.is_a?(Socket) || socket.is_a?(BasicSocket)
          @clients[socket] = { buffer: String.new, seen: monotonic }
        end
        @clients.keys.each { |socket| service(socket) }
        # After servicing, so a request that arrived during a long call is still answered.
        now = monotonic
        @clients.select { |_, client| now - client[:seen] > IDLE_SECONDS }.each_key { |socket| close_client(socket) }
      rescue StandardError => error
        puts "[Inertia CAD Bridge] #{error.class}: #{error.message}"
      ensure
        @busy = false
      end
    end

    def self.service(socket)
      chunk = socket.read_nonblock(65_536, exception: false)
      return if chunk == :wait_readable
      return close_client(socket) if chunk.nil?
      client = @clients[socket]
      client[:seen] = monotonic
      buffer = client[:buffer]
      buffer << chunk
      return close_client(socket) if buffer.bytesize > MAX_REQUEST_BYTES
      while (newline = buffer.index("\n"))
        line = buffer.slice!(0..newline)
        @current_client = socket
        begin
          response = handle_line(line)
        ensure
          @current_client = nil
        end
        socket.write("#{encode_response(response)}\n")
        client[:seen] = monotonic
      end
    rescue IOError, SystemCallError
      close_client(socket)
    end

    # Always one line back, even for a result JSON cannot hold (invalid UTF-8, NaN). The request
    # may already have run, so Inertia must treat this as an unknown outcome, not a failure.
    def self.encode_response(response)
      JSON.generate(response)
    rescue StandardError => error
      JSON.generate(
        'v' => PROTOCOL, 'id' => response['id'].is_a?(String) ? response['id'] : nil, 'ok' => false,
        'error' => { 'code' => 'HOST_UNREADABLE', 'message' => "SketchUp could not encode its answer (#{error.class})." }
      )
    end

    def self.close_client(socket)
      @clients.delete(socket) if @clients
      socket.close unless socket.closed?
    rescue StandardError
      nil
    end

    class RevisionObserver < Sketchup::ModelObserver
      def initialize(document_id)
        super()
        @document_id = document_id
      end

      def onTransactionCommit(_model)
        CadBridge.bump(@document_id)
      end

      def onTransactionUndo(_model)
        CadBridge.bump(@document_id)
      end

      def onTransactionRedo(_model)
        CadBridge.bump(@document_id)
      end

      def onActivePathChanged(_model)
        CadBridge.bump(@document_id)
      end
    end

    class AppObserver < Sketchup::AppObserver
      def onQuit
        CadBridge.stop
      end
    end
  end
end

Inertia::CadBridge.start unless ENV['INERTIA_CAD_BRIDGE_TEST'] == '1'
